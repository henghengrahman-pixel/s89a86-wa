import pg from "pg";
const { Pool } = pg;

const ssl = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
  ? { rejectUnauthorized: false }
  : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: Number(process.env.DB_POOL_MAX || 10),
  min: Number(process.env.DB_POOL_MIN || 1),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
  keepAlive: true
});

export async function initDb() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wa_id TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      display_name TEXT,
      profile_name TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TIMESTAMPTZ,
      last_message_preview TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(contact_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      provider_message_id TEXT UNIQUE,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      message_type TEXT NOT NULL DEFAULT 'text',
      body TEXT,
      media_url TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      raw_payload JSONB,
      sent_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS reply_to_message_id UUID;
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS reply_to_provider_message_id TEXT;
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS provider_reply_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_messages_provider_reply_id
      ON messages(provider_reply_id);

    CREATE TABLE IF NOT EXISTS media_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS provider_event_bound BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS message_send_requests (
      client_request_id TEXT PRIMARY KEY,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'processing',
      message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
      error_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_send_requests_conversation_created
      ON message_send_requests(conversation_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_last_message
      ON conversations(last_message_at DESC NULLS LAST);

    CREATE INDEX IF NOT EXISTS idx_conversations_archive_last
      ON conversations(is_archived, last_message_at DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_contacts_last_seen
      ON contacts(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_provider_reply_id
      ON messages(provider_reply_id);
    CREATE INDEX IF NOT EXISTS idx_messages_outbound_reconcile
      ON messages(conversation_id, created_at DESC)
      WHERE direction='out' AND provider_event_bound=FALSE;
    CREATE INDEX IF NOT EXISTS idx_messages_contact_direction
      ON messages(contact_id, direction, created_at DESC);
    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT UNIQUE,
      event_type TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_events_created
      ON webhook_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
      ) THEN
        ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
      END IF;
    END$$;
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
}

export async function upsertContact({ waId, phone, displayName, profileName }) {
  const { rows } = await pool.query(`
    INSERT INTO contacts (wa_id, phone, display_name, profile_name, last_seen_at, updated_at)
    VALUES ($1,$2,$3,$4,NOW(),NOW())
    ON CONFLICT (wa_id) DO UPDATE SET
      phone = EXCLUDED.phone,
      display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
      profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name),
      last_seen_at = NOW(),
      updated_at = NOW()
    RETURNING *
  `, [waId, phone, displayName || null, profileName || null]);
  return rows[0];
}

export async function upsertConversation(contactId, { activate = true } = {}) {
  const { rows } = await pool.query(`
    INSERT INTO conversations (contact_id, status, updated_at)
    VALUES ($1,'open',NOW())
    ON CONFLICT (contact_id) DO UPDATE SET
      status = CASE WHEN $2 THEN 'open' ELSE conversations.status END,
      is_archived = CASE WHEN $2 THEN FALSE ELSE conversations.is_archived END,
      archived_at = CASE WHEN $2 THEN NULL ELSE conversations.archived_at END,
      updated_at = CASE WHEN $2 THEN NOW() ELSE conversations.updated_at END
    RETURNING *
  `, [contactId, activate]);
  return rows[0];
}

export async function insertInboundMessage({ conversationId, contactId, providerMessageId, providerReplyId = null, type, body, mediaUrl, rawPayload, createdAt, replyToMessageId = null, replyToProviderMessageId = null }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ts = createdAt ? new Date(createdAt) : new Date();

    let inserted;
    try {
      const r = await client.query(`
        INSERT INTO messages
          (conversation_id, contact_id, provider_message_id, provider_reply_id, direction, message_type, body, media_url, status, raw_payload, created_at, updated_at, reply_to_message_id, reply_to_provider_message_id)
        VALUES ($1,$2,$3,$4,'in',$5,$6,$7,'received',$8,$9,$9,$10,$11)
        RETURNING *
      `, [conversationId, contactId, providerMessageId || null, providerReplyId || null, type || "text", body || "", mediaUrl || null, rawPayload, ts, replyToMessageId, replyToProviderMessageId]);
      inserted = r.rows[0];
    } catch (e) {
      if (e.code === "23505" && providerMessageId) {
        await client.query("ROLLBACK");
        const r = await pool.query(`SELECT * FROM messages WHERE provider_message_id=$1`, [providerMessageId]);
        return { message: r.rows[0], duplicate: true };
      }
      throw e;
    }

    await client.query(`
      UPDATE conversations
      SET unread_count = unread_count + 1,
          last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
          last_message_preview = CASE WHEN last_message_at IS NULL OR last_message_at <= $2 THEN $3 ELSE last_message_preview END,
          updated_at = NOW()
      WHERE id=$1
    `, [conversationId, inserted.created_at, body || `[${type || "message"}]`]);

    await client.query("COMMIT");
    return { message: inserted, duplicate: false };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function insertOutboundMessage({
  conversationId, contactId, providerMessageId, providerReplyId = null, body, rawPayload, sentBy,
  createdAt, status = "sent", messageType = "text", mediaUrl = null,
  replyToMessageId = null, replyToProviderMessageId = null, providerEventBound = false
}) {
  const ts = createdAt ? new Date(createdAt) : new Date();
  let rows;
  try {
    const r = await pool.query(`
      INSERT INTO messages
        (conversation_id, contact_id, provider_message_id, provider_reply_id, direction, message_type, body, media_url, status, raw_payload, sent_by, created_at, updated_at, reply_to_message_id, reply_to_provider_message_id, provider_event_bound)
      VALUES ($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14)
      RETURNING *
    `, [
      conversationId, contactId, providerMessageId || null, providerReplyId || null, messageType || "text",
      body || "", mediaUrl || null, status || "sent", rawPayload || null,
      sentBy || null, ts, replyToMessageId, replyToProviderMessageId, providerEventBound
    ]);
    rows = r.rows;
  } catch (e) {
    if (e.code === "23505" && providerMessageId) {
      const r = await pool.query(`SELECT * FROM messages WHERE provider_message_id=$1`, [providerMessageId]);
      return { ...r.rows[0], duplicate: true };
    }
    throw e;
  }

  await pool.query(`
    UPDATE conversations
    SET last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
        last_message_preview = CASE WHEN last_message_at IS NULL OR last_message_at <= $2 THEN $3 ELSE last_message_preview END,
        updated_at=NOW()
    WHERE id=$1
  `, [conversationId, rows[0].created_at, body || `[${messageType || "message"}]`]);

  return rows[0];
}


export async function claimSendRequest({ clientRequestId, conversationId }) {
  if (!clientRequestId) return { claimed:true, existing:null };

  try {
    const { rows } = await pool.query(`
      INSERT INTO message_send_requests(client_request_id,conversation_id,status)
      VALUES ($1,$2,'processing')
      ON CONFLICT (client_request_id) DO NOTHING
      RETURNING *
    `,[clientRequestId,conversationId]);

    if (rows[0]) return { claimed:true, existing:null };

    const existing = await pool.query(`
      SELECT * FROM message_send_requests
      WHERE client_request_id=$1
      LIMIT 1
    `,[clientRequestId]);

    const row = existing.rows[0] || null;
    if (!row) return { claimed:false, existing:null };

    const stale = row.status === 'processing' &&
      (Date.now() - new Date(row.updated_at || row.created_at).getTime()) > 90000;

    if (stale) {
      const retried = await pool.query(`
        UPDATE message_send_requests
        SET status='processing',
            error_text=NULL,
            updated_at=NOW()
        WHERE client_request_id=$1
          AND status='processing'
          AND updated_at < NOW() - INTERVAL '90 seconds'
        RETURNING *
      `,[clientRequestId]);

      if (retried.rows[0]) return { claimed:true, existing:null };
    }

    return { claimed:false, existing:row };
  } catch(e) {
    if (e.code === '23505') {
      const existing = await pool.query(`
        SELECT * FROM message_send_requests
        WHERE client_request_id=$1
        LIMIT 1
      `,[clientRequestId]);
      return { claimed:false, existing:existing.rows[0] || null };
    }
    throw e;
  }
}

export async function finishSendRequest({ clientRequestId, messageId, errorText = null }) {
  if (!clientRequestId) return;
  await pool.query(`
    UPDATE message_send_requests
    SET status=$2,
        message_id=$3,
        error_text=$4,
        updated_at=NOW()
    WHERE client_request_id=$1
  `,[clientRequestId, errorText ? 'failed' : 'done', messageId || null, errorText]);
}

export async function findSendRequestMessage(clientRequestId) {
  if (!clientRequestId) return null;
  const { rows } = await pool.query(`
    SELECT m.*
    FROM message_send_requests r
    LEFT JOIN messages m ON m.id=r.message_id
    WHERE r.client_request_id=$1
  `,[clientRequestId]);
  return rows[0] || null;
}

export async function reconcileOutboundWebhook({
  conversationId,
  providerMessageId,
  providerReplyId,
  body,
  mediaUrl,
  status = 'sent',
  messageType = 'text',
  rawPayload = null,
  createdAt = null
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (providerMessageId) {
      const exact = await client.query(`
        SELECT * FROM messages
        WHERE provider_message_id=$1
        LIMIT 1
        FOR UPDATE
      `,[providerMessageId]);

      if (exact.rows[0]) {
        const updated = await client.query(`
          UPDATE messages
          SET provider_reply_id=COALESCE($2,provider_reply_id),
              status=CASE
                WHEN status='read' THEN 'read'
                WHEN status='delivered' AND COALESCE($3,status) IN ('received','sent') THEN 'delivered'
                WHEN status='failed' AND COALESCE($3,status) IN ('received','sent') THEN 'failed'
                ELSE COALESCE($3,status)
              END,
              raw_payload=COALESCE($4,raw_payload),
              provider_event_bound=TRUE,
              updated_at=NOW()
          WHERE id=$1
          RETURNING *
        `,[exact.rows[0].id, providerReplyId || null, status || null, rawPayload]);
        await client.query("COMMIT");
        return { message:updated.rows[0], merged:true };
      }
    }

    const ts = createdAt ? new Date(createdAt) : new Date();
    const candidate = await client.query(`
      SELECT *
      FROM messages
      WHERE conversation_id=$1
        AND direction='out'
        AND provider_event_bound=FALSE
        AND COALESCE(body,'')=$2
        AND COALESCE(media_url,'')=COALESCE($3,'')
        AND created_at BETWEEN ($4::timestamptz - interval '90 seconds')
                           AND ($4::timestamptz + interval '90 seconds')
      ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $4::timestamptz))) ASC
      LIMIT 1
      FOR UPDATE
    `,[conversationId, body || "", mediaUrl || null, ts]);

    if (candidate.rows[0]) {
      const updated = await client.query(`
        UPDATE messages
        SET provider_message_id=COALESCE($2,provider_message_id),
            provider_reply_id=COALESCE($3,provider_reply_id),
            status=CASE
              WHEN status='read' THEN 'read'
              WHEN status='delivered' AND COALESCE($4,status) IN ('received','sent') THEN 'delivered'
              WHEN status='failed' AND COALESCE($4,status) IN ('received','sent') THEN 'failed'
              ELSE COALESCE($4,status)
            END,
            raw_payload=COALESCE($5,raw_payload),
            provider_event_bound=TRUE,
            updated_at=NOW()
        WHERE id=$1
        RETURNING *
      `,[
        candidate.rows[0].id,
        providerMessageId || null,
        providerReplyId || null,
        status || null,
        rawPayload
      ]);
      await client.query("COMMIT");
      return { message:updated.rows[0], merged:true };
    }

    await client.query("COMMIT");
    return { message:null, merged:false };
  } catch(e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function saveMediaAsset({ token, filename, mimeType, sizeBytes, data }) {
  const { rows } = await pool.query(`
    INSERT INTO media_assets(token,filename,mime_type,size_bytes,data)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id,token,filename,mime_type,size_bytes,created_at
  `, [token, filename, mimeType, sizeBytes, data]);
  return rows[0];
}

export async function getMediaAssetByToken(token) {
  const { rows } = await pool.query(`
    SELECT * FROM media_assets WHERE token=$1
  `, [token]);
  return rows[0] || null;
}

export async function updateMessageStatus(providerMessageId, status) {
  if (!providerMessageId || !status) return null;

  const normalized = String(status).toLowerCase();
  if (!['received','sent','delivered','read','failed'].includes(normalized)) return null;

  const { rows } = await pool.query(`
    UPDATE messages
    SET status = CASE
      WHEN $2='failed' THEN
        CASE WHEN status IN ('delivered','read') THEN status ELSE 'failed' END
      WHEN status='read' THEN 'read'
      WHEN status='delivered' AND $2 IN ('received','sent') THEN 'delivered'
      WHEN status='failed' AND $2 IN ('received','sent') THEN 'failed'
      ELSE $2
    END,
    updated_at=NOW()
    WHERE provider_message_id=$1 OR provider_reply_id=$1
    RETURNING *
  `,[providerMessageId,normalized]);

  return rows[0] || null;
}

export async function saveWebhookEvent(eventKey, eventType, payload) {
  const { rowCount } = await pool.query(`
    INSERT INTO webhook_events(event_key,event_type,payload)
    VALUES ($1,$2,$3)
    ON CONFLICT (event_key) DO NOTHING
  `,[eventKey || null,eventType || null,payload]);
  return rowCount === 1;
}

export async function purgeOperationalData() {
  // Raw webhook/debug events do not need indefinite retention.
  await pool.query(`DELETE FROM webhook_events WHERE created_at < NOW() - INTERVAL '30 days'`);
  await pool.query(`DELETE FROM message_send_requests WHERE created_at < NOW() - INTERVAL '7 days'`);
}
