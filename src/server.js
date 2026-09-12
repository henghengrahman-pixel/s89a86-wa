import http from "http";
import crypto from "crypto";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import helmet from "helmet";
import multer from "multer";
import bcrypt from "bcryptjs";
import { Server as SocketIOServer } from "socket.io";
import {
  pool, initDb, upsertContact, upsertConversation, insertInboundMessage,
  insertOutboundMessage, updateMessageStatus, saveWebhookEvent,
  saveMediaAsset, getMediaAssetByToken, claimSendRequest, finishSendRequest,
  findSendRequestMessage, reconcileOutboundWebhook, purgeOperationalData
} from "./db.js";
import { normalizeWebhook } from "./webhook-normalizer.js";
import { sendText, sendMessage, resolveSendUrl } from "./provider.js";

function assertConfig() {
  const req = ["DATABASE_URL","ADMIN_USERNAME","ADMIN_PASSWORD","SESSION_SECRET","CONTACTS_PIN"];
  const missing = req.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`CONFIG_ERROR: env wajib belum diisi: ${missing.join(", ")}`);
  if ((process.env.SESSION_SECRET || "").length < 32) throw new Error("CONFIG_ERROR: SESSION_SECRET minimal 32 karakter.");
  if ((process.env.CONTACTS_PIN || "").length < 4) throw new Error("CONFIG_ERROR: CONTACTS_PIN minimal 4 karakter.");
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: false } });
const PgStore = pgSession(session);

app.set("view engine", "ejs");
app.set("views", new URL("../views", import.meta.url).pathname);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(new URL("../public", import.meta.url).pathname));


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }
});

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/,"");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

function mediaTypeFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

app.set("trust proxy", 1);
const sessionMiddleware = session({
  store: new PgStore({ pool, tableName: "session" }),
  secret: process.env.SESSION_SECRET || "dev-dev-dev-dev-dev-dev-dev-dev-1234",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", httpOnly: true, sameSite: "lax", maxAge: 12*60*60*1000 }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

function authed(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ ok:false, error:"UNAUTHORIZED" });
}

function safeEqualText(a, b) {
  const aa = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function authedPage(req, res, next) {
  if (req.session?.user) return next();
  res.redirect("/login");
}



app.get("/media/:token", async (req,res)=>{
  const asset = await getMediaAssetByToken(req.params.token);
  if (!asset) return res.status(404).send("Not found");
  res.setHeader("Content-Type", asset.mime_type || "application/octet-stream");
  res.setHeader("Content-Length", String(asset.size_bytes || asset.data?.length || 0));
  res.setHeader(
    "Content-Disposition",
    `${String(asset.mime_type || "").startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`
  );
  res.setHeader("Cache-Control","public, max-age=31536000, immutable");
  res.send(asset.data);
});

app.get("/health", (_req,res)=>res.json({
  ok:true,
  time:new Date().toISOString(),
  databaseConfigured:Boolean(process.env.DATABASE_URL),
  contactsPinConfigured:Boolean(process.env.CONTACTS_PIN),
  outboundConfigured:Boolean(process.env.API_CO_ID_API_KEY && resolveSendUrl()),
  outboundUrl:resolveSendUrl()
}));


app.post("/api/debug/replay-webhooks", authed, async (_req,res)=>{
  await replaySavedWebhooks();
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM conversations`);
  res.json({ok:true,conversations:rows[0]?.count || 0});
});


app.get("/api/provider/config", authed, (_req,res)=>{
  res.json({
    ok:true,
    sendUrl:resolveSendUrl(),
    apiKeyConfigured:Boolean(process.env.API_CO_ID_API_KEY),
    phoneNumberIdConfigured:Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
    authHeader:process.env.API_CO_ID_AUTH_HEADER || "Authorization",
    authPrefix:process.env.API_CO_ID_AUTH_PREFIX ?? "Bearer"
  });
});

app.get("/api/debug/webhooks", authed, async (_req,res)=>{
  const { rows } = await pool.query(`
    SELECT id,event_key,event_type,payload,created_at
    FROM webhook_events
    ORDER BY id DESC
    LIMIT 50
  `);
  res.json({ok:true,events:rows});
});


app.get("/login", (req,res)=>{
  if (req.session?.user) return res.redirect("/");
  res.render("login", { error: null });
});
app.post("/login", async (req,res)=>{
  const { username, password } = req.body;
  const ok = username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD;
  if (!ok) return res.status(401).render("login",{error:"ID atau password salah."});
  req.session.user = { username };
  res.redirect("/");
});
app.post("/logout", (req,res)=>req.session.destroy(()=>res.redirect("/login")));


app.get("/contacts", authedPage, async (req,res)=>{
  if (!req.session.contactsUnlocked) {
    return res.render("contacts-lock", { error: null });
  }

  const { rows } = await pool.query(`
    SELECT
      ct.id,
      ct.wa_id,
      ct.phone,
      ct.display_name,
      ct.profile_name,
      ct.first_seen_at,
      ct.last_seen_at,
      COUNT(m.id)::int AS total_messages,
      COUNT(*) FILTER (WHERE m.direction='in')::int AS inbound_messages,
      COUNT(*) FILTER (WHERE m.direction='out')::int AS outbound_messages
    FROM contacts ct
    LEFT JOIN messages m ON m.contact_id = ct.id
    GROUP BY ct.id
    ORDER BY ct.last_seen_at DESC, ct.created_at DESC
  `);

  res.render("contacts", { contacts: rows });
});

app.post("/contacts/unlock", authedPage, async (req,res)=>{
  const pin = String(req.body?.pin || "");
  if (!safeEqualText(pin, process.env.CONTACTS_PIN || "")) {
    return res.status(401).render("contacts-lock", { error: "PIN kontak salah." });
  }
  req.session.contactsUnlocked = true;
  req.session.save(()=>res.redirect("/contacts"));
});

app.post("/contacts/lock", authedPage, (req,res)=>{
  req.session.contactsUnlocked = false;
  req.session.save(()=>res.redirect("/contacts"));
});

app.get("/", authedPage, (_req,res)=>res.render("inbox"));

app.get("/api/conversations", authed, async (req,res)=>{
  const archived = String(req.query.archived || "0") === "1";
  const { rows } = await pool.query(`
    SELECT c.*, ct.wa_id, ct.phone, ct.display_name, ct.profile_name
    FROM conversations c
    JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.is_archived=$1
    ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC
    LIMIT 300
  `,[archived]);
  res.json({ok:true, conversations:rows, archived});
});

app.get("/api/conversations/:id/messages", authed, async (req,res)=>{
  const c = await pool.query(`
    SELECT c.*, ct.wa_id, ct.phone, ct.display_name, ct.profile_name
    FROM conversations c
    JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.id=$1
  `,[req.params.id]);

  if (!c.rows[0]) return res.status(404).json({ok:false,error:"NOT_FOUND"});

  const m = await pool.query(`
    WITH recent AS (
      SELECT *
      FROM messages
      WHERE conversation_id=$1
      ORDER BY created_at DESC
      LIMIT 500
    )
    SELECT
      recent.*,
      r.body AS reply_body,
      r.message_type AS reply_message_type,
      r.direction AS reply_direction
    FROM recent
    LEFT JOIN messages r ON r.id=recent.reply_to_message_id
    ORDER BY recent.created_at ASC
  `,[req.params.id]);

  res.json({ok:true,conversation:c.rows[0],messages:m.rows});
});

app.post("/api/conversations/:id/read", authed, async (req,res)=>{
  await pool.query(`UPDATE conversations SET unread_count=0,updated_at=NOW() WHERE id=$1`,[req.params.id]);
  io.emit("conversation:update",{id:req.params.id,unread_count:0});
  res.json({ok:true});
});

app.post("/api/conversations/:id/status", authed, async (req,res)=>{
  const status = req.body?.status === "closed" ? "closed" : "open";
  const {rows}=await pool.query(`UPDATE conversations SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[req.params.id,status]);
  io.emit("conversation:update",rows[0]);
  res.json({ok:true,conversation:rows[0]});
});

app.post("/api/conversations/:id/archive", authed, async (req,res)=>{
  const archived = Boolean(req.body?.archived);
  const { rows } = await pool.query(`
    UPDATE conversations
    SET is_archived=$2,
        archived_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
        updated_at=NOW()
    WHERE id=$1
    RETURNING *
  `,[req.params.id, archived]);
  if (!rows[0]) return res.status(404).json({ok:false,error:"Percakapan tidak ditemukan."});
  io.emit("conversation:refresh",{id:req.params.id});
  res.json({ok:true,conversation:rows[0]});
});


app.post("/api/conversations/:id/messages", authed, async (req,res)=>{
  const body = String(req.body?.body || "").trim();
  const replyToId = req.body?.replyToMessageId ? String(req.body.replyToMessageId) : null;
  const clientRequestId = req.body?.clientRequestId ? String(req.body.clientRequestId) : null;

  if (!body) return res.status(400).json({ok:false,error:"Pesan kosong."});

  const q = await pool.query(`
    SELECT c.id, c.contact_id, ct.phone, ct.wa_id
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.id=$1
  `,[req.params.id]);
  const conv=q.rows[0];
  if (!conv) return res.status(404).json({ok:false,error:"Percakapan tidak ditemukan."});

  const claim = await claimSendRequest({clientRequestId,conversationId:conv.id});
  if (!claim.claimed) {
    const existing = await findSendRequestMessage(clientRequestId);
    if (existing) return res.json({ok:true,message:existing,deduplicated:true});
    if (claim.existing?.status === "processing") {
      return res.status(202).json({ok:true,processing:true,deduplicated:true});
    }
    return res.status(409).json({ok:false,error:"Request kirim yang sama sudah diproses sebelumnya."});
  }

  let replyTarget = null;
  if (replyToId) {
    const r = await pool.query(`
      SELECT id,provider_message_id,provider_reply_id FROM messages
      WHERE id=$1 AND conversation_id=$2
    `,[replyToId, conv.id]);
    replyTarget = r.rows[0] || null;
  }

  try {
    const provider = await sendText({
      to: conv.wa_id || conv.phone,
      text: body,
      replyToMessageId: replyTarget?.provider_reply_id || replyTarget?.provider_message_id || null
    });

    const msg = await insertOutboundMessage({
      conversationId:conv.id,
      contactId:conv.contact_id,
      providerMessageId:provider.messageId,
      providerReplyId:provider.messageId,
      body,
      rawPayload:provider.raw,
      sentBy:req.session.user.username,
      replyToMessageId:replyTarget?.id || null,
      replyToProviderMessageId:replyTarget?.provider_reply_id || replyTarget?.provider_message_id || null,
      providerEventBound:false
    });

    await finishSendRequest({clientRequestId,messageId:msg.id});
    io.emit("message:new",msg);
    io.emit("conversation:refresh",{id:conv.id});
    res.json({ok:true,message:msg,provider:provider.raw});
  } catch (e) {
    await finishSendRequest({clientRequestId,messageId:null,errorText:e.message}).catch(()=>{});
    console.error("SEND_FAILED", e.message, e.providerResponse || "");
    res.status(502).json({ok:false,error:e.message,provider:e.providerResponse || null});
  }
});


app.post("/api/conversations/:id/media", authed, upload.single("file"), async (req,res)=>{
  if (!req.file) return res.status(400).json({ok:false,error:"File belum dipilih."});

  const caption = String(req.body?.caption || "").trim();
  const replyToId = req.body?.replyToMessageId ? String(req.body.replyToMessageId) : null;
  const clientRequestId = req.body?.clientRequestId ? String(req.body.clientRequestId) : null;

  const q = await pool.query(`
    SELECT c.id, c.contact_id, ct.phone, ct.wa_id
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.id=$1
  `,[req.params.id]);
  const conv = q.rows[0];
  if (!conv) return res.status(404).json({ok:false,error:"Percakapan tidak ditemukan."});

  const claim = await claimSendRequest({clientRequestId,conversationId:conv.id});
  if (!claim.claimed) {
    const existing = await findSendRequestMessage(clientRequestId);
    if (existing) return res.json({ok:true,message:existing,deduplicated:true});
    if (claim.existing?.status === "processing") {
      return res.status(202).json({ok:true,processing:true,deduplicated:true});
    }
    return res.status(409).json({ok:false,error:"Request kirim yang sama sudah diproses sebelumnya."});
  }

  let replyTarget = null;
  if (replyToId) {
    const r = await pool.query(`
      SELECT id,provider_message_id,provider_reply_id FROM messages
      WHERE id=$1 AND conversation_id=$2
    `,[replyToId,conv.id]);
    replyTarget = r.rows[0] || null;
  }

  try {
    const token = crypto.randomBytes(24).toString("hex");
    const asset = await saveMediaAsset({
      token,
      filename:req.file.originalname || "file",
      mimeType:req.file.mimetype || "application/octet-stream",
      sizeBytes:req.file.size,
      data:req.file.buffer
    });

    const mediaUrl = `${publicBaseUrl(req)}/media/${asset.token}`;
    const messageType = mediaTypeFromMime(req.file.mimetype);

    const provider = await sendMessage({
      to:conv.wa_id || conv.phone,
      messageType,
      content:caption,
      mediaUrl,
      replyToMessageId:replyTarget?.provider_reply_id || replyTarget?.provider_message_id || null
    });

    const msg = await insertOutboundMessage({
      conversationId:conv.id,
      contactId:conv.contact_id,
      providerMessageId:provider.messageId,
      providerReplyId:provider.messageId,
      body:caption || req.file.originalname || `[${messageType}]`,
      mediaUrl,
      rawPayload:provider.raw,
      sentBy:req.session.user.username,
      messageType,
      replyToMessageId:replyTarget?.id || null,
      replyToProviderMessageId:replyTarget?.provider_reply_id || replyTarget?.provider_message_id || null,
      providerEventBound:false
    });

    await finishSendRequest({clientRequestId,messageId:msg.id});
    io.emit("message:new",msg);
    io.emit("conversation:refresh",{id:conv.id});
    res.json({ok:true,message:msg,provider:provider.raw});
  } catch(e) {
    await finishSendRequest({clientRequestId,messageId:null,errorText:e.message}).catch(()=>{});
    console.error("SEND_MEDIA_FAILED",e.message,e.providerResponse || "");
    res.status(502).json({ok:false,error:e.message,provider:e.providerResponse || null});
  }
});

function verifySignature(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  const sig = req.get("x-hub-signature-256") || req.get("x-webhook-signature");
  if (!sig) return false;
  const raw = JSON.stringify(req.body);
  const expected = "sha256=" + crypto.createHmac("sha256",secret).update(raw).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)); } catch { return false; }
}


async function processWebhookPayload(payload, emitRealtime = true) {
  const events = normalizeWebhook(payload);
  console.log("[WEBHOOK_NORMALIZED]", JSON.stringify(events.map(e => ({
    kind:e.kind, providerMessageId:e.providerMessageId, waId:e.waId, phone:e.phone,
    direction:e.direction, type:e.type, body:e.body, status:e.status
  }))));

  if (!events.length) {
    console.warn("[WEBHOOK_UNRECOGNIZED] event_type=", payload?.event_type || payload?.event || payload?.type || "unknown");
    return { processed:0 };
  }

  let processed = 0;

  for (const ev of events) {
    if (ev.kind === "status") {
      const updated = await updateMessageStatus(ev.providerMessageId, ev.status);
      if (updated && emitRealtime) io.emit("message:update", updated);
      processed++;
      continue;
    }

    if (ev.kind === "message" || ev.kind === "outbound_message") {
      const waId = String(ev.waId || ev.phone || "").trim();
      if (!waId) continue;

      const contact = await upsertContact({
        waId,
        phone: ev.phone || waId,
        displayName: ev.displayName || waId,
        profileName: ev.profileName || null
      });
      const conv = await upsertConversation(contact.id, { activate: emitRealtime });

      let replyTargetInternal = null;
      if (ev.replyToProviderMessageId) {
        const rq = await pool.query(
          `SELECT id FROM messages
           WHERE provider_reply_id=$1 OR provider_message_id=$1
           ORDER BY created_at DESC
           LIMIT 1`,
          [ev.replyToProviderMessageId]
        );
        replyTargetInternal = rq.rows[0]?.id || null;
      }

      if (ev.kind === "message") {
        const ins = await insertInboundMessage({
          conversationId: conv.id,
          contactId: contact.id,
          providerMessageId: ev.providerMessageId,
          providerReplyId: ev.providerReplyId || ev.providerMessageId || null,
          type: ev.type,
          body: ev.body,
          mediaUrl: ev.mediaUrl,
          rawPayload: ev.raw,
          createdAt: ev.createdAt,
          replyToMessageId: replyTargetInternal,
          replyToProviderMessageId: ev.replyToProviderMessageId || null
        });
        if (!ins.duplicate && emitRealtime) {
          io.emit("message:new", ins.message);
          io.emit("conversation:refresh", {id:conv.id});
        }
      } else {
        const reconciled = await reconcileOutboundWebhook({
          conversationId:conv.id,
          providerMessageId:ev.providerMessageId,
          providerReplyId:ev.providerReplyId || ev.providerMessageId || null,
          body:ev.body,
          mediaUrl:ev.mediaUrl || null,
          status:ev.status || "sent",
          messageType:ev.type || "text",
          rawPayload:ev.raw,
          createdAt:ev.createdAt
        });

        if (reconciled.merged) {
          if (emitRealtime && reconciled.message) io.emit("message:update",reconciled.message);
        } else {
          const out = await insertOutboundMessage({
            conversationId: conv.id,
            contactId: contact.id,
            providerMessageId: ev.providerMessageId,
            providerReplyId: ev.providerReplyId || ev.providerMessageId || null,
            body: ev.body,
            mediaUrl: ev.mediaUrl || null,
            rawPayload: ev.raw,
            sentBy: "provider",
            createdAt: ev.createdAt,
            status: ev.status || "sent",
            messageType: ev.type || "text",
            replyToMessageId: replyTargetInternal,
            replyToProviderMessageId: ev.replyToProviderMessageId || null,
            providerEventBound:true
          });
          if (!out?.duplicate && emitRealtime) io.emit("message:new",out);
        }

        if (emitRealtime) io.emit("conversation:refresh",{id:conv.id});
      }
      processed++;
    }
  }

  return { processed };
}

async function replaySavedWebhooks() {
  const { rows } = await pool.query(`
    SELECT payload
    FROM webhook_events
    ORDER BY id DESC
    LIMIT 5000
  `);
  rows.reverse();

  let processed = 0;
  for (const row of rows) {
    try {
      const r = await processWebhookPayload(row.payload, false);
      processed += r.processed || 0;
    } catch (e) {
      console.error("[WEBHOOK_REPLAY_ITEM_FAILED]", e.message);
    }
  }

  if (rows.length) {
    console.log(`[WEBHOOK_REPLAY] ${rows.length} event dibaca, ${processed} event dikenali.`);
  }
}

app.get("/webhooks/api-co-id",(req,res)=>{
  const token = req.query["hub.verify_token"] || req.query.verify_token || req.query.token;
  const challenge = req.query["hub.challenge"] || req.query.challenge;
  if (process.env.WEBHOOK_VERIFY_TOKEN && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge || "OK");
  }
  res.status(403).send("Forbidden");
});

app.post("/webhooks/api-co-id", async (req,res)=>{
  // balas cepat ke provider, proses event setelah payload lolos verifikasi
  if (!verifySignature(req)) return res.status(401).json({ok:false,error:"INVALID_SIGNATURE"});
  res.status(200).json({ok:true});

  try {
    const payload=req.body;
    console.log("[WEBHOOK_RECEIVED]", payload?.event_type || payload?.event || payload?.type || "webhook");
    const key = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const isNew = await saveWebhookEvent(
      key,
      payload?.event_type || payload?.event || payload?.type || "webhook",
      payload
    );
    if (!isNew) return;
    await processWebhookPayload(payload, true);
  } catch(e) {
    console.error("WEBHOOK_PROCESS_FAILED",e);
  }
});

io.use((socket,next)=>{
  if (socket.request.session?.user) return next();
  next(new Error("unauthorized"));
});
io.on("connection",socket=>{
  socket.emit("ready",{ok:true});
});

const port=Number(process.env.PORT||8080);
assertConfig();
await initDb();
await purgeOperationalData().catch(e=>console.warn("[PURGE_WARNING]",e.message));

if (String(process.env.REPLAY_WEBHOOKS_ON_BOOT || "false").toLowerCase() === "true") {
  await replaySavedWebhooks();
}

server.listen(port,()=>console.log(`WA Inbox listening on :${port}`));
