import http from "http";
import crypto from "crypto";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import { Server as SocketIOServer } from "socket.io";
import {
  pool, initDb, upsertContact, upsertConversation, insertInboundMessage,
  insertOutboundMessage, updateMessageStatus, saveWebhookEvent
} from "./db.js";
import { normalizeWebhook } from "./webhook-normalizer.js";
import { sendText } from "./provider.js";

function assertConfig() {
  const req = ["DATABASE_URL","ADMIN_USERNAME","ADMIN_PASSWORD","SESSION_SECRET"];
  const missing = req.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`CONFIG_ERROR: env wajib belum diisi: ${missing.join(", ")}`);
  if ((process.env.SESSION_SECRET || "").length < 32) throw new Error("CONFIG_ERROR: SESSION_SECRET minimal 32 karakter.");
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: false } });
const PgStore = pgSession(session);

app.set("view engine", "ejs");
app.set("views", new URL("../views", import.meta.url).pathname);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(new URL("../public", import.meta.url).pathname));

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
function authedPage(req, res, next) {
  if (req.session?.user) return next();
  res.redirect("/login");
}

app.get("/health", (_req,res)=>res.json({ok:true,time:new Date().toISOString()}));

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

app.get("/", authedPage, (_req,res)=>res.render("inbox"));

app.get("/api/conversations", authed, async (_req,res)=>{
  const { rows } = await pool.query(`
    SELECT c.*, ct.wa_id, ct.phone, ct.display_name, ct.profile_name
    FROM conversations c
    JOIN contacts ct ON ct.id=c.contact_id
    ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC
    LIMIT 500
  `);
  res.json({ok:true, conversations:rows});
});

app.get("/api/conversations/:id/messages", authed, async (req,res)=>{
  const c = await pool.query(`
    SELECT c.*, ct.wa_id, ct.phone, ct.display_name, ct.profile_name
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.id=$1
  `,[req.params.id]);
  if (!c.rows[0]) return res.status(404).json({ok:false,error:"NOT_FOUND"});
  const m = await pool.query(`
    SELECT * FROM messages WHERE conversation_id=$1
    ORDER BY created_at ASC LIMIT 1000
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

app.post("/api/conversations/:id/messages", authed, async (req,res)=>{
  const body = String(req.body?.body || "").trim();
  if (!body) return res.status(400).json({ok:false,error:"Pesan kosong."});
  const q = await pool.query(`
    SELECT c.id, c.contact_id, ct.phone, ct.wa_id
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.id=$1
  `,[req.params.id]);
  const conv=q.rows[0];
  if (!conv) return res.status(404).json({ok:false,error:"Percakapan tidak ditemukan."});
  try {
    const provider = await sendText({to: conv.wa_id || conv.phone, text: body});
    const msg = await insertOutboundMessage({
      conversationId:conv.id, contactId:conv.contact_id,
      providerMessageId:provider.messageId, body, rawPayload:provider.raw,
      sentBy:req.session.user.username
    });
    io.emit("message:new",msg);
    io.emit("conversation:refresh",{id:conv.id});
    res.json({ok:true,message:msg,provider:provider.raw});
  } catch (e) {
    console.error("SEND_FAILED", e.message, e.providerResponse || "");
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
    const key = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    await saveWebhookEvent(key, payload?.event || payload?.type || "webhook", payload);
    const events=normalizeWebhook(payload);
    for (const ev of events) {
      if (ev.kind==="status") {
        const updated=await updateMessageStatus(ev.providerMessageId,ev.status);
        if (updated) io.emit("message:update",updated);
        continue;
      }
      if (ev.kind==="message") {
        const waId=String(ev.waId||ev.phone||"").trim();
        if (!waId) continue;
        const contact=await upsertContact({
          waId, phone:ev.phone||waId,
          displayName:ev.displayName||waId, profileName:ev.profileName||null
        });
        const conv=await upsertConversation(contact.id);
        const ins=await insertInboundMessage({
          conversationId:conv.id, contactId:contact.id,
          providerMessageId:ev.providerMessageId,
          type:ev.type, body:ev.body, mediaUrl:ev.mediaUrl, rawPayload:ev.raw
        });
        if (!ins.duplicate) {
          io.emit("message:new",ins.message);
          io.emit("conversation:refresh",{id:conv.id});
        }
      }
    }
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
server.listen(port,()=>console.log(`WA Inbox listening on :${port}`));
