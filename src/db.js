import pg from "pg";
const { Pool } = pg;

const ssl = String(process.env.DATABASE_SSL || "false").toLowerCase() === "true"
  ? { rejectUnauthorized: false }
  : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl
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

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_last_message
      ON conversations(last_message_at DESC NULLS LAST);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT UNIQUE,
      event_type TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

export async function upsertConversation(contactId) {
  const { rows } = await pool.query(`
    INSERT INTO conversations (contact_id, status, updated_at)
    VALUES ($1,'open',NOW())
    ON CONFLICT (contact_id) DO UPDATE SET
      status='open',
      updated_at=NOW()
    RETURNING *
  `, [contactId]);
  return rows[0];
}

export async function insertInboundMessage({ conversationId, contactId, providerMessageId, type, body, mediaUrl, rawPayload }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted;
    try {
      const r = await client.query(`
        INSERT INTO messages
          (conversation_id, contact_id, provider_message_id, direction, message_type, body, media_url, status, raw_payload)
        VALUES ($1,$2,$3,'in',$4,$5,$6,'received',$7)
        RETURNING *
      `, [conversationId, contactId, providerMessageId || null, type || "text", body || "", mediaUrl || null, rawPayload]);
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
          last_message_at = $2,
          last_message_preview = $3,
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

export async function insertOutboundMessage({ conversationId, contactId, providerMessageId, body, rawPayload, sentBy }) {
  const { rows } = await pool.query(`
    INSERT INTO messages
      (conversation_id, contact_id, provider_message_id, direction, message_type, body, status, raw_payload, sent_by)
    VALUES ($1,$2,$3,'out','text',$4,'sent',$5,$6)
    RETURNING *
  `, [conversationId, contactId, providerMessageId || null, body, rawPayload || null, sentBy || null]);

  await pool.query(`
    UPDATE conversations
    SET last_message_at=$2,
        last_message_preview=$3,
        updated_at=NOW()
    WHERE id=$1
  `, [conversationId, rows[0].created_at, body]);

  return rows[0];
}

export async function updateMessageStatus(providerMessageId, status) {
  if (!providerMessageId || !status) return null;
  const { rows } = await pool.query(`
    UPDATE messages
    SET status=$2, updated_at=NOW()
    WHERE provider_message_id=$1
    RETURNING *
  `, [providerMessageId, status]);
  return rows[0] || null;
}

export async function saveWebhookEvent(eventKey, eventType, payload) {
  try {
    await pool.query(`
      INSERT INTO webhook_events(event_key,event_type,payload)
      VALUES ($1,$2,$3)
      ON CONFLICT (event_key) DO NOTHING
    `, [eventKey || null, eventType || null, payload]);
  } catch {}
}
