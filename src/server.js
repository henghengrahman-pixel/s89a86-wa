import http from "http";
import crypto from "crypto";
import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import helmet from "helmet";
import compression from "compression";
import multer from "multer";
import { Server as SocketIOServer } from "socket.io";
import {
  pool, initDb, upsertContact, upsertConversation, insertInboundMessage,
  insertOutboundMessage, updateMessageStatus, saveWebhookEvent,
  saveMediaAsset, getMediaAssetByToken, claimSendRequest, finishSendRequest,
  findSendRequestMessage, reconcileOutboundWebhook, purgeOperationalData,
  syncConversationMeta, upsertSyncedMessage, getConversationSummary
} from "./db.js";
import { normalizeWebhook } from "./webhook-normalizer.js";
import { sendText, sendMessage, resolveSendUrl, listConversations, getConversationMessages, markMessageRead, sendTyping, getWindowStatus, listWebhooks, uploadMedia } from "./provider.js";

function assertConfig() {
  const req = ["DATABASE_URL","ADMIN_USERNAME","ADMIN_PASSWORD","SESSION_SECRET","CONTACTS_PIN"];
  const missing = req.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`CONFIG_ERROR: env wajib belum diisi: ${missing.join(", ")}`);
  if ((process.env.SESSION_SECRET || "").length < 32) throw new Error("CONFIG_ERROR: SESSION_SECRET minimal 32 karakter.");
  if ((process.env.CONTACTS_PIN || "").length < 4) throw new Error("CONFIG_ERROR: CONTACTS_PIN minimal 4 karakter.");
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: false },
  transports: ["websocket", "polling"],
  perMessageDeflate: false,
  pingInterval: 25000,
  pingTimeout: 20000
});
const PgStore = pgSession(session);

app.set("view engine", "ejs");
app.set("views", new URL("../views", import.meta.url).pathname);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({ threshold: 1024 }));
app.use(express.json({
  limit: "5mb",
  verify: (req,_res,buf)=>{
    if (String(req.originalUrl || "").startsWith("/webhooks/")) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(new URL("../public", import.meta.url).pathname, {
  maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
  etag: true,
  immutable: process.env.NODE_ENV === "production"
}));


const ALLOWED_UPLOAD_MIME = new Set([
  "image/jpeg","image/png","image/webp","image/gif",
  "video/mp4","video/webm","video/quicktime",
  "audio/mpeg","audio/ogg","audio/mp4","audio/wav","audio/x-wav",
  "application/pdf","text/plain",
  "application/zip","application/x-zip-compressed",
  "application/vnd.rar","application/x-rar-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

const MAX_UPLOAD_MB = Math.max(1,Math.min(20,Number(process.env.MAX_UPLOAD_MB || 20)));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files:1 },
  fileFilter: (_req,file,cb)=>{
    if (!ALLOWED_UPLOAD_MIME.has(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Jenis file tidak didukung."));
    }
    cb(null,true);
  }
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


app.use("/api", (_req,res,next)=>{
  res.setHeader("Cache-Control","no-store");
  next();
});


function digitsOnly(v){ return String(v ?? '').replace(/\D/g,''); }
function pick(obj, paths){
  for(const path of paths){
    const v=path.split('.').reduce((a,k)=>a?.[k],obj);
    if(v!==undefined && v!==null && v!=='') return v;
  }
  return null;
}
function toIso(v){
  if(!v) return null;
  if(typeof v==='number' || /^\d{10,13}$/.test(String(v))){
    const n=Number(v); const ms=String(Math.trunc(n)).length<=10?n*1000:n;
    const d=new Date(ms); return Number.isNaN(d.getTime())?null:d.toISOString();
  }
  const d=new Date(v); return Number.isNaN(d.getTime())?null:d.toISOString();
}
function normalizeProviderConversation(row){
  const customer=row?.customer || row?.contact || {};
  const phone=digitsOnly(pick(row,['customer_phone','phone_number','phone','wa_id','customer.phone_number','customer.phone','contact.phone_number','contact.phone']));
  const customerId=pick(row,['customer_id','customer.id','contact_id','contact.id','id']);
  const name=pick(row,['customer_name','name','display_name','profile_name','customer.name','customer.display_name','contact.name']) || phone;
  const last=row?.last_message || row?.message || {};
  const preview=pick(row,['last_message_preview','last_message.content','last_message.text','last_message.body','message.content','message.text','message.body']);
  const lastAt=toIso(pick(row,['last_message_at','last_message.created_at','last_message.timestamp','updated_at','message.created_at']));
  const unreadRaw=pick(row,['unread_count','unread','unread_messages']);
  const unread=Number.isFinite(Number(unreadRaw))?Math.max(0,Number(unreadRaw)):null;
  return {phone,customerId:customerId?String(customerId):null,name:String(name||phone||''),preview:preview==null?null:String(preview),lastAt,unread};
}
function normalizeProviderMessage(row){
  const raw=row?.message || row;
  const id=pick(raw,['message_id','id','provider_message_id','wamid']);
  const dir=String(pick(raw,['direction','message_direction'])||'').toLowerCase();
  const fromMe=pick(raw,['is_from_me','from_me','fromMe']);
  const direction=(fromMe===true || fromMe===1 || fromMe==='1' || fromMe==='true' || ['out','outbound','sent'].includes(dir))?'out':'in';
  const type=String(pick(raw,['message_type','type'])||'text').toLowerCase();
  let body=pick(raw,['content','body','text.body','text','caption']);
  if(body && typeof body==='object') body=JSON.stringify(body);
  const mediaUrl=pick(raw,['media_url','media.url','image.url','image.link','video.url','video.link','audio.url','audio.link','document.url','document.link']);
  const status=String(pick(raw,['status']) || (direction==='out'?'sent':'received')).toLowerCase();
  const createdAt=toIso(pick(raw,['created_at','timestamp','sent_at','received_at'])) || new Date().toISOString();
  const replyTo=pick(raw,['reply_to_message_id','context.id']);
  return {providerMessageId:id?String(id):null,providerReplyId:id?String(id):null,direction,messageType:type,body:body==null?'':String(body),mediaUrl:mediaUrl?String(mediaUrl):null,status,createdAt,replyToProviderMessageId:replyTo?String(replyTo):null};
}

const syncLocks=new Map();
async function withSyncLock(key,fn){
  if(syncLocks.has(key)) return syncLocks.get(key);
  const task=Promise.resolve().then(fn).finally(()=>syncLocks.delete(key));
  syncLocks.set(key,task); return task;
}
async function syncProviderConversations({limit=50,cursor=null}={}){
  if(!process.env.API_CO_ID_API_KEY) return {synced:0,nextCursor:null,provider:false};
  return withSyncLock(`conversations:${cursor||'first'}`,async()=>{
    const remote=await listConversations({limit,cursor,channel:'whatsapp'});
    let synced=0;
    for(const row of remote.items){
      const n=normalizeProviderConversation(row); if(!n.phone) continue;
      const contact=await upsertContact({waId:n.phone,phone:n.phone,displayName:n.name,profileName:n.name,providerCustomerId:n.customerId});
      const conv=await upsertConversation(contact.id,{activate:false});
      await syncConversationMeta({conversationId:conv.id,unreadCount:n.unread,lastMessageAt:n.lastAt,lastMessagePreview:n.preview});
      synced++;
    }
    return {synced,nextCursor:remote.nextCursor,provider:true};
  });
}
async function syncProviderMessagesForConversation(conv,{limit=50,cursor=null}={}){
  if(!process.env.API_CO_ID_API_KEY) return {synced:0,nextCursor:null,provider:false};
  const identifier=conv.provider_customer_id || conv.wa_id || conv.phone;
  if(!identifier) return {synced:0,nextCursor:null,provider:false};
  return withSyncLock(`messages:${conv.id}:${cursor||'latest'}`,async()=>{
    let remote;
    try{remote=await getConversationMessages(identifier,{limit,cursor});}
    catch(e){
      if(conv.provider_customer_id && (conv.wa_id||conv.phone)) remote=await getConversationMessages(conv.wa_id||conv.phone,{limit,cursor});
      else throw e;
    }
    let synced=0;
    for(const row of remote.items){
      const n=normalizeProviderMessage(row); if(!n.providerMessageId) continue;
      await upsertSyncedMessage({conversationId:conv.id,contactId:conv.contact_id,...n,rawPayload:null});
      synced++;
    }
    return {synced,nextCursor:remote.nextCursor,provider:true};
  });
}

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

  const data = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data || []);
  const total = data.length;
  const mime = asset.mime_type || "application/octet-stream";
  const inline = /^(image|video|audio)\//i.test(mime);

  res.setHeader("Content-Type",mime);
  res.setHeader("Accept-Ranges","bytes");
  res.setHeader("Cache-Control","public, max-age=31536000, immutable");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`
  );

  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startText,endText] = range.replace("bytes=","").split("-");
    let start = startText ? Number(startText) : 0;
    let end = endText ? Number(endText) : total - 1;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
      res.status(416).setHeader("Content-Range",`bytes */${total}`);
      return res.end();
    }

    end = Math.min(end,total-1);
    const chunk = data.subarray(start,end+1);

    res.status(206);
    res.setHeader("Content-Range",`bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length",String(chunk.length));
    return res.end(chunk);
  }

  res.setHeader("Content-Length",String(total));
  res.end(data);
});

app.get("/ready", async (_req,res)=>{
  try{
    await pool.query("SELECT 1");
    res.json({
      ok:true,
      database:true,
      outboundConfigured:Boolean(process.env.API_CO_ID_API_KEY && resolveSendUrl()),
      sendUrl:resolveSendUrl()
    });
  }catch(e){
    res.status(503).json({ok:false,database:false,error:e.message});
  }
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


app.get("/api/provider/webhooks",authed,async(_req,res)=>{
  try{const w=await listWebhooks();res.json({ok:true,webhooks:w.items});}
  catch(e){res.status(502).json({ok:false,error:e.message,provider:e.providerResponse||null});}
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
  req.session.regenerate(err=>{
    if (err) return res.status(500).render("login",{error:"Gagal membuat sesi login."});
    req.session.user = { username };
    req.session.save(()=>res.redirect("/"));
  });
});
app.post("/logout", (req,res)=>req.session.destroy(()=>res.redirect("/login")));


app.get("/contacts", authedPage, async (req,res)=>{
  const unlockedUntil = Number(req.session.contactsUnlockedUntil || 0);
  if (!unlockedUntil || Date.now() >= unlockedUntil) {
    req.session.contactsUnlockedUntil = 0;
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
  const ttlMinutes = Math.max(1,Math.min(120,Number(process.env.CONTACTS_PIN_TTL_MINUTES || 10)));
  req.session.contactsUnlockedUntil = Date.now() + ttlMinutes*60*1000;
  req.session.save(()=>res.redirect("/contacts"));
});

app.post("/contacts/lock", authedPage, (req,res)=>{
  req.session.contactsUnlockedUntil = 0;
  req.session.save(()=>res.redirect("/contacts"));
});

app.get("/", authedPage, (_req,res)=>res.render("inbox"));

app.get("/api/conversations", authed, async (req,res)=>{
  const archived=String(req.query.archived||'0')==='1';
  const limit=Math.max(20,Math.min(100,Number(req.query.limit||50)||50));
  if(!archived && String(req.query.sync||'1')==='1' && process.env.API_CO_ID_API_KEY){
    setImmediate(()=>syncProviderConversations({limit}).then(()=>io.emit('conversation:refresh',{source:'provider-sync'})).catch(e=>console.warn('[CONVERSATION_SYNC_WARNING]',e.message)));
  }
  const {rows}=await pool.query(`
    SELECT c.*,ct.wa_id,ct.phone,ct.display_name,ct.profile_name,ct.provider_customer_id
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
    WHERE c.is_archived=$1
    ORDER BY c.last_message_at DESC NULLS LAST,c.updated_at DESC
    LIMIT $2
  `,[archived,limit]);
  res.json({ok:true,conversations:rows,archived,limit});
});

app.post("/api/provider/sync-conversations",authed,async(req,res)=>{
  try{const result=await syncProviderConversations({limit:Math.max(20,Math.min(100,Number(req.body?.limit||50)||50)),cursor:req.body?.cursor||null});io.emit('conversation:refresh',{source:'provider-sync'});res.json({ok:true,...result});}
  catch(e){res.status(502).json({ok:false,error:e.message,provider:e.providerResponse||null});}
});

app.get("/api/conversations/:id/messages",authed,async(req,res)=>{
  const limit=Math.max(20,Math.min(100,Number(req.query.limit||50)||50));
  const before=req.query.before?String(req.query.before):null;
  const c=await getConversationSummary(req.params.id);
  if(!c) return res.status(404).json({ok:false,error:'NOT_FOUND'});
  if(!before && String(req.query.sync||'1')==='1' && process.env.API_CO_ID_API_KEY){
    const localCount=await pool.query(`SELECT COUNT(*)::int count FROM messages WHERE conversation_id=$1`,[c.id]);
    if((localCount.rows[0]?.count||0)===0){
      try{await Promise.race([syncProviderMessagesForConversation(c,{limit}),new Promise((_,rej)=>setTimeout(()=>rej(new Error('SYNC_TIMEOUT')),1800))]);}catch(e){if(e.message!=='SYNC_TIMEOUT')console.warn('[MESSAGE_SYNC_WARNING]',e.message);}
    }
  }
  const params=[req.params.id,limit];
  const beforeSql=before?'AND m.created_at < $3::timestamptz':''; if(before)params.push(before);
  const {rows}=await pool.query(`
    WITH recent AS (
      SELECT m.id,m.conversation_id,m.contact_id,m.provider_message_id,m.provider_reply_id,m.direction,m.message_type,m.body,m.media_url,m.status,m.sent_by,m.created_at,m.updated_at,m.reply_to_message_id,m.reply_to_provider_message_id
      FROM messages m WHERE m.conversation_id=$1 ${beforeSql}
      ORDER BY m.created_at DESC,m.id DESC LIMIT $2
    )
    SELECT recent.*,r.body reply_body,r.message_type reply_message_type,r.direction reply_direction
    FROM recent LEFT JOIN messages r ON r.id=recent.reply_to_message_id
    ORDER BY recent.created_at ASC,recent.id ASC
  `,params);
  const nextBefore=rows.length===limit?rows[0]?.created_at:null;
  res.json({ok:true,conversation:c,messages:rows,limit,nextBefore});
});

app.post("/api/conversations/:id/sync-messages",authed,async(req,res)=>{
  const c=await getConversationSummary(req.params.id); if(!c)return res.status(404).json({ok:false,error:'NOT_FOUND'});
  try{const result=await syncProviderMessagesForConversation(c,{limit:Math.max(20,Math.min(100,Number(req.body?.limit||50)||50)),cursor:req.body?.cursor||null});
    const fresh=await getConversationSummary(c.id); io.emit('conversation:update',fresh); res.json({ok:true,...result});
  }catch(e){res.status(502).json({ok:false,error:e.message,provider:e.providerResponse||null});}
});

app.post("/api/conversations/:id/read",authed,async(req,res)=>{
  const c=await getConversationSummary(req.params.id); if(!c)return res.status(404).json({ok:false,error:'NOT_FOUND'});
  await pool.query(`UPDATE conversations SET unread_count=0,updated_at=NOW() WHERE id=$1`,[c.id]);
  const q=await pool.query(`SELECT provider_message_id FROM messages WHERE conversation_id=$1 AND direction='in' AND provider_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,[c.id]);
  const providerId=q.rows[0]?.provider_message_id;
  if(providerId) markMessageRead(providerId).catch(e=>console.warn('[MARK_READ_WARNING]',e.message));
  io.emit('conversation:update',{...c,unread_count:0}); res.json({ok:true});
});

app.post("/api/conversations/:id/typing",authed,async(req,res)=>{
  const c=await getConversationSummary(req.params.id); if(!c)return res.status(404).json({ok:false,error:'NOT_FOUND'});
  try{await sendTyping({identifier:c.wa_id||c.phone});res.json({ok:true});}catch(e){res.status(502).json({ok:false,error:e.message});}
});

app.get("/api/conversations/:id/window-status",authed,async(req,res)=>{
  const c=await getConversationSummary(req.params.id); if(!c)return res.status(404).json({ok:false,error:'NOT_FOUND'});
  try{const data=await getWindowStatus(c.provider_customer_id||c.wa_id||c.phone);res.json({ok:true,data});}catch(e){res.status(502).json({ok:false,error:e.message});}
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

    const localMediaUrl = `${publicBaseUrl(req)}/media/${asset.token}`;
    const messageType = mediaTypeFromMime(req.file.mimetype);
    let providerMediaRef = localMediaUrl;
    try {
      const uploaded = await uploadMedia({buffer:req.file.buffer,filename:req.file.originalname || 'file',mimeType:req.file.mimetype});
      providerMediaRef = uploaded.mediaId || uploaded.mediaUrl || localMediaUrl;
    } catch (uploadErr) {
      console.warn('[PROVIDER_MEDIA_UPLOAD_FALLBACK]',uploadErr.message);
    }

    const provider = await sendMessage({
      to:conv.wa_id || conv.phone,
      messageType,
      content:caption,
      mediaUrl:providerMediaRef,
      replyToMessageId:replyTarget?.provider_reply_id || replyTarget?.provider_message_id || null
    });
    const mediaUrl = localMediaUrl;

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
  const secret = String(process.env.WEBHOOK_SECRET || "");
  if (!secret) return true;

  const supplied = String(
    req.get("x-hub-signature-256") ||
    req.get("x-webhook-signature") ||
    ""
  ).trim();

  if (!supplied) return false;

  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const hex = crypto.createHmac("sha256",secret).update(raw).digest("hex");
  const candidates = [`sha256=${hex}`,hex];

  return candidates.some(expected=>{
    try{
      const a=Buffer.from(supplied);
      const b=Buffer.from(expected);
      return a.length===b.length && crypto.timingSafeEqual(a,b);
    }catch{
      return false;
    }
  });
}


async function processWebhookPayload(payload, emitRealtime = true) {
  const events = normalizeWebhook(payload);
  console.log("[WEBHOOK_NORMALIZED]", JSON.stringify(events.map(e => ({
    kind:e.kind,
    providerMessageId:e.providerMessageId,
    direction:e.direction,
    type:e.type,
    status:e.status,
    phone:e.phone
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
  if (!verifySignature(req)) {
    return res.status(401).json({ok:false,error:"INVALID_SIGNATURE"});
  }

  const payload=req.body;

  try {
    const eventKey = String(
      payload?.event_id ||
      payload?.id ||
      crypto.createHash("sha256").update(req.rawBody || Buffer.from(JSON.stringify(payload))).digest("hex")
    );

    const isNew = await saveWebhookEvent(
      eventKey,
      payload?.event_type || payload?.event || payload?.type || "webhook",
      payload
    );

    res.status(200).json({ok:true,duplicate:!isNew});

    if (!isNew) return;

    setImmediate(()=>{
      processWebhookPayload(payload,true).catch(e=>{
        console.error("WEBHOOK_PROCESS_FAILED",e);
      });
    });
  } catch(e) {
    console.error("WEBHOOK_PERSIST_FAILED",e);
    if (!res.headersSent) {
      return res.status(503).json({ok:false,error:"WEBHOOK_STORAGE_UNAVAILABLE"});
    }
  }
});

app.use((err,req,res,next)=>{
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `Ukuran file maksimal ${MAX_UPLOAD_MB} MB.`
      : "Upload file gagal.";
    return res.status(400).json({ok:false,error:message,code:err.code});
  }

  if (err?.message === "Jenis file tidak didukung.") {
    return res.status(400).json({ok:false,error:err.message,code:"UNSUPPORTED_FILE_TYPE"});
  }

  console.error("[HTTP_ERROR]",err);
  if (req.path?.startsWith("/api/")) {
    return res.status(500).json({ok:false,error:"INTERNAL_SERVER_ERROR"});
  }

  res.status(500).send("Internal Server Error");
});

// UPLOAD_TOO_LARGE marker

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

const cleanupTimer = setInterval(()=>{
  purgeOperationalData().catch(e=>console.warn("[PURGE_WARNING]",e.message));
},6*60*60*1000);
cleanupTimer.unref();

server.listen(port,()=>console.log(`WA Inbox listening on :${port}`));

let shuttingDown=false;
async function shutdown(signal){
  if (shuttingDown) return;
  shuttingDown=true;
  console.log(`[SHUTDOWN] ${signal}`);

  clearInterval(cleanupTimer);

  const forceTimer=setTimeout(()=>{
    console.error("[SHUTDOWN] forced");
    process.exit(1);
  },10000);
  forceTimer.unref();

  try{
    io.close();
    await new Promise(resolve=>server.close(()=>resolve()));
    await pool.end();
    clearTimeout(forceTimer);
    process.exit(0);
  }catch(e){
    console.error("[SHUTDOWN_ERROR]",e);
    process.exit(1);
  }
}

process.once("SIGTERM",()=>shutdown("SIGTERM"));
process.once("SIGINT",()=>shutdown("SIGINT"));
