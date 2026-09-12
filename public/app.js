const socket = io({ transports:["websocket","polling"] });
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const listEl = $("#conversationList");
const searchEl = $("#search");
const empty = $("#emptyState");
const chatView = $("#chatView");
const chatPane = $(".wa-main");
const msgEl = $("#messages");
const nameEl = $("#chatName");
const phoneEl = $("#chatPhone");
const composer = $("#composer");
const input = $("#messageInput");
const sendBtn = $("#sendBtn");
const sendError = $("#sendError");
const toggleStatus = $("#toggleStatus");
const archiveBtn = $("#archiveBtn");
const mobileBack = $("#mobileBack");
const replyBar = $("#replyBar");
const replyText = $("#replyText");
const cancelReply = $("#cancelReply");
const attachBtn = $("#attachBtn");
const hashtagBtn = $("#hashtagBtn");
const fileInput = $("#fileInput");
const attachmentBar = $("#attachmentBar");
const attachmentName = $("#attachmentName");
const attachmentPreview = $("#attachmentPreview");
const cancelAttachment = $("#cancelAttachment");
const snippetMenu = $("#snippetMenu");
const manageSnippetsBtn = $("#manageSnippetsBtn");
const snippetModal = $("#snippetModal");
const closeSnippetModal = $("#closeSnippetModal");
const snippetSearch = $("#snippetSearch");
const snippetLibraryList = $("#snippetLibraryList");
const newSnippetBtn = $("#newSnippetBtn");
const snippetForm = $("#snippetForm");
const snippetId = $("#snippetId");
const snippetShortcut = $("#snippetShortcut");
const snippetTitle = $("#snippetTitle");
const snippetSort = $("#snippetSort");
const snippetContent = $("#snippetContent");
const snippetActive = $("#snippetActive");
const deleteSnippetBtn = $("#deleteSnippetBtn");
const resetSnippetBtn = $("#resetSnippetBtn");
const snippetFormStatus = $("#snippetFormStatus");
const tabButtons = $$(".wa-tab");

let conversations = [];
let current = null;
let currentMessages = [];
let currentMode = "inbox";
let replyTarget = null;
let selectedFile = null;
let isSending = false;
let openSeq = 0;
let openController = null;
let listTimer = null;
let listLoading = false;
let pendingListReload = false;
let nextBefore = null;
let loadingOlder = false;
let typingTimer = null;
let lastTypingAt = 0;
let quickReplies = [];
let snippetMenuIndex = -1;
let snippetSearchTimer = null;
const messageCache = new Map();

const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const fmt = t => t ? new Date(t).toLocaleTimeString("id-ID", { hour:"2-digit", minute:"2-digit" }) : "";
const initial = s => (String(s || "?").trim()[0] || "?").toUpperCase();
const short = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 90);
const normalizeShortcut = s => String(s || "").trim().replace(/^#+/,"").toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_\-]/g,"").slice(0,60);
function statusMeta(status, pending = false, failed = false) {
  if (failed) return { text:"!", cls:"failed", title:"Gagal dikirim" };
  if (pending) return { text:"◷", cls:"pending", title:"Mengirim" };
  const s = String(status || "sent").toLowerCase();
  if (s === "read") return { text:"✓✓", cls:"read", title:"Dibaca" };
  if (s === "delivered") return { text:"✓✓", cls:"delivered", title:"Terkirim" };
  if (s === "sent") return { text:"✓", cls:"sent", title:"Terkirim ke server" };
  if (s === "failed") return { text:"!", cls:"failed", title:"Gagal dikirim" };
  return { text:"✓", cls:"sent", title:s };
}
function statusMarkup(m) {
  const st = statusMeta(m?.status, Boolean(m?._pending), Boolean(m?._failed));
  return `<span class="status ${esc(st.cls)}" title="${esc(st.title)}">${esc(st.text)}</span>`;
}

async function api(url, opt = {}) {
  const headers = { ...(opt.headers || {}) };
  if (opt.body && !(opt.body instanceof FormData)) headers["content-type"] = "application/json";
  const r = await fetch(url, { ...opt, headers, credentials:"same-origin" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { data, status:r.status });
  return data;
}

function setStatusMessage(text = "", type = "") {
  if (!text) {
    snippetFormStatus.textContent = "";
    snippetFormStatus.className = "form-status hidden";
    return;
  }
  snippetFormStatus.textContent = text;
  snippetFormStatus.className = `form-status ${type}`;
}

function renderList() {
  const q = searchEl.value.trim().toLowerCase();
  const rows = conversations.filter(c => [c.display_name,c.profile_name,c.phone,c.last_message_preview].join(" ").toLowerCase().includes(q));
  listEl.innerHTML = rows.length ? rows.map(c => `
    <div class="conv ${current?.id===c.id?"active":""}" data-id="${esc(c.id)}">
      <div class="conv-avatar">${esc(initial(c.display_name||c.phone))}</div>
      <div class="conv-main">
        <div class="conv-top">
          <div class="conv-name">${esc(c.display_name||c.profile_name||c.phone)}</div>
          <div class="conv-time">${fmt(c.last_message_at)}</div>
        </div>
        <div class="conv-bottom">
          <div class="conv-preview">${esc(c.last_message_preview||"Belum ada pesan")}</div>
          ${Number(c.unread_count)>0?`<span class="unread">${Number(c.unread_count)>99?"99+":Number(c.unread_count)}</span>`:""}
        </div>
      </div>
    </div>`).join("") : `<div class="list-empty">${currentMode==="archived"?"Belum ada chat di arsip.":"Belum ada percakapan."}</div>`;
}

async function loadConversations({ backgroundSync = true } = {}) {
  if (listLoading) { pendingListReload = true; return; }
  listLoading = true;
  try {
    const d = await api(`/api/conversations?archived=${currentMode==="archived"?"1":"0"}&limit=50&sync=${backgroundSync?"1":"0"}`);
    conversations = Array.isArray(d.conversations) ? d.conversations : [];
    if (current) {
      const fresh = conversations.find(x => x.id === current.id);
      if (fresh) current = { ...current, ...fresh };
    }
    renderList();
  } finally {
    listLoading = false;
    if (pendingListReload) {
      pendingListReload = false;
      scheduleConversationReload(120);
    }
  }
}
function scheduleConversationReload(delay = 250) {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => loadConversations({ backgroundSync:false }).catch(console.error), delay);
}

listEl.addEventListener("click", e => {
  const row = e.target.closest(".conv");
  if (row) openConversation(row.dataset.id);
});
let searchTimer = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 60);
});
tabButtons.forEach(btn => btn.addEventListener("click", () => {
  currentMode = btn.dataset.mode;
  tabButtons.forEach(x => x.classList.toggle("active", x === btn));
  current = null;
  chatView.classList.add("hidden");
  empty.classList.remove("hidden");
  chatPane.classList.remove("mobile-open");
  loadConversations().catch(console.error);
}));

function updateHeader() {
  if (!current) return;
  nameEl.textContent = current.display_name || current.profile_name || current.phone || "-";
  phoneEl.textContent = current.phone || "";
  toggleStatus.textContent = current.status === "closed" ? "Buka chat" : "Tutup chat";
  archiveBtn.title = current.is_archived ? "Keluarkan dari arsip" : "Arsipkan chat";
  archiveBtn.textContent = current.is_archived ? "↥" : "⌄";
}
function mergeMessages(base, incoming) {
  const map = new Map();
  for (const m of [...(base || []), ...(incoming || [])]) {
    if (!m) continue;
    const key = m.id || m.provider_message_id;
    if (!key) continue;
    map.set(String(key), { ...(map.get(String(key)) || {}), ...m });
  }
  return [...map.values()].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
}

async function openConversation(id) {
  const seq = ++openSeq;
  nextBefore = null;
  loadingOlder = false;
  const local = conversations.find(x => x.id === id);
  if (local) current = { ...local };
  empty.classList.add("hidden");
  chatView.classList.remove("hidden");
  chatPane.classList.add("mobile-open");
  clearReply();
  clearAttachment();
  hideSnippetMenu();
  updateHeader();
  renderList();
  const cached = messageCache.get(id);
  if (cached?.length) {
    currentMessages = cached;
    renderMessages(cached, true);
  } else {
    msgEl.innerHTML = `<div class="chat-loading"><span></span><span></span><span></span></div>`;
  }
  openController?.abort();
  const controller = new AbortController();
  openController = controller;
  try {
    const d = await api(`/api/conversations/${id}/messages?limit=50&sync=1`, { signal:controller.signal });
    if (seq !== openSeq) return;
    current = d.conversation;
    nextBefore = d.nextBefore || null;
    currentMessages = mergeMessages([], d.messages || []);
    messageCache.set(id, currentMessages);
    updateHeader();
    renderMessages(currentMessages, true);
    const row = conversations.find(x => x.id === id);
    if (row) row.unread_count = 0;
    renderList();
    api(`/api/conversations/${id}/read`, { method:"POST", body:"{}" }).catch(() => {});
    api(`/api/conversations/${id}/sync-messages`, { method:"POST", body:JSON.stringify({ limit:50 }) })
      .then(() => api(`/api/conversations/${id}/messages?limit=50&sync=0`))
      .then(fresh => {
        if (seq !== openSeq || current?.id !== id) return;
        current = fresh.conversation;
        nextBefore = fresh.nextBefore || nextBefore;
        currentMessages = mergeMessages(currentMessages, fresh.messages || []);
        messageCache.set(id, currentMessages);
        updateHeader();
        renderMessages(currentMessages, true);
      })
      .catch(err => console.warn("[DIRECT_SYNC_WARNING]", err.message));
  } catch (err) {
    if (err?.name === "AbortError" || seq !== openSeq) return;
    if (cached?.length) { console.warn("[OPEN_CHAT_STALE_CACHE]", err.message); return; }
    msgEl.innerHTML = `<div class="chat-load-error">Chat gagal dimuat. <button type="button" id="retryChat">Coba lagi</button></div>`;
    $("#retryChat")?.addEventListener("click", () => openConversation(id));
  } finally {
    if (openController === controller) openController = null;
  }
}

async function loadOlderMessages() {
  if (!current || !nextBefore || loadingOlder) return;
  loadingOlder = true;
  const oldHeight = msgEl.scrollHeight, oldTop = msgEl.scrollTop;
  try {
    const d = await api(`/api/conversations/${current.id}/messages?limit=50&sync=0&before=${encodeURIComponent(nextBefore)}`);
    nextBefore = d.nextBefore || null;
    currentMessages = mergeMessages(d.messages || [], currentMessages);
    messageCache.set(current.id, currentMessages);
    renderMessages(currentMessages, false);
    requestAnimationFrame(() => { msgEl.scrollTop = msgEl.scrollHeight - oldHeight + oldTop; });
  } catch (e) {
    console.warn("[LOAD_OLDER_WARNING]", e.message);
  } finally {
    loadingOlder = false;
  }
}
msgEl.addEventListener("scroll", () => { if (msgEl.scrollTop < 90) loadOlderMessages(); }, { passive:true });

function mediaMarkup(m) {
  if (!m.media_url) return "";
  const type = String(m.message_type || "").toLowerCase();
  const u = esc(m.media_url);
  if (type === "image") return `<a href="${u}" target="_blank" rel="noopener"><img class="msg-media" loading="lazy" decoding="async" src="${u}" alt="Gambar"></a>`;
  if (type === "video") return `<video class="msg-media" controls preload="metadata" src="${u}"></video>`;
  if (type === "audio") return `<audio class="msg-media" controls preload="none" src="${u}"></audio>`;
  return `<a class="doc-card" href="${u}" target="_blank" rel="noopener"><span class="doc-icon">📄</span><span>${esc(m.body || "Buka dokumen")}</span></a>`;
}
function messageHtml(m, prev) {
  const direction = m.direction === "out" ? "out" : "in";
  const senderSwitch = prev && prev.direction !== m.direction ? " sender-switch" : "";
  const bodyHtml = m.body && !(m.media_url && String(m.message_type).toLowerCase() === "document") ? `<span class="bubble-text">${esc(m.body)}</span>` : "";
  const pending = m._pending ? " pending" : "";
  const failed = m._failed ? " failed" : "";
  return `<div class="message-row ${direction}${senderSwitch}${pending}${failed}" data-message-id="${esc(m.id || m.provider_message_id)}"><div class="bubble-wrap">
    ${!m._pending?`<button class="reply-btn" type="button" data-reply="${esc(m.id)}" title="Balas pesan">↩</button>`:""}<div class="bubble">
    ${m.reply_to_message_id ? `<div class="reply-quote"><strong>${m.reply_direction === "out" ? "Anda" : "Member"}</strong>${esc(short(m.reply_body || `[${m.reply_message_type || "pesan"}]`))}</div>` : ""}
    ${mediaMarkup(m)}${bodyHtml}<span class="bubble-meta">${fmt(m.created_at)} ${direction === "out" ? statusMarkup(m) : ""}</span></div></div></div>`;
}
function renderMessages(messages, scrollBottom = false) {
  const visible = (Array.isArray(messages) ? messages : []).filter(m => m && (m.id || m.provider_message_id));
  currentMessages = visible;
  if (!visible.length) {
    msgEl.innerHTML = `<div class="chat-empty-messages">Belum ada pesan pada percakapan ini.</div>`;
    return;
  }
  msgEl.innerHTML = visible.map((m,i) => messageHtml(m, visible[i - 1])).join("");
  if (scrollBottom) requestAnimationFrame(() => { msgEl.scrollTop = msgEl.scrollHeight; });
}
msgEl.addEventListener("click", e => {
  const btn = e.target.closest("[data-reply]");
  if (!btn) return;
  const m = currentMessages.find(x => x.id === btn.dataset.reply);
  if (!m) return;
  replyTarget = m;
  replyText.textContent = short(m.body || `[${m.message_type}]`);
  replyBar.classList.remove("hidden");
  input.focus();
});
function clearReply() {
  replyTarget = null;
  replyBar.classList.add("hidden");
  replyText.textContent = "";
}
cancelReply.addEventListener("click", clearReply);

function setSelectedFile(file) {
  if (!file) return;
  const maxBytes = 20 * 1024 * 1024;
  if (file.size > maxBytes) {
    sendError.textContent = "Ukuran file maksimal 20 MB.";
    sendError.classList.remove("hidden");
    return;
  }
  sendError.classList.add("hidden");
  selectedFile = file;
  attachmentName.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  if (attachmentPreview) {
    attachmentPreview.innerHTML = "";
    if (String(file.type || "").startsWith("image/")) {
      const url = URL.createObjectURL(file);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "Preview";
      img.onload = () => URL.revokeObjectURL(url);
      attachmentPreview.appendChild(img);
    }
  }
  attachmentBar.classList.remove("hidden");
  input.placeholder = "Tambahkan caption (opsional)";
}
attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) setSelectedFile(f);
});
function clearAttachment() {
  selectedFile = null;
  fileInput.value = "";
  attachmentBar.classList.add("hidden");
  attachmentName.textContent = "";
  if (attachmentPreview) attachmentPreview.innerHTML = "";
  input.placeholder = "Ketik pesan";
}
cancelAttachment.addEventListener("click", clearAttachment);
input.addEventListener("paste", e => {
  const item = [...(e.clipboardData?.items || [])].find(x => x.kind === "file" && String(x.type || "").startsWith("image/"));
  if (!item) return;
  const f = item.getAsFile();
  if (!f) return;
  e.preventDefault();
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  setSelectedFile(new File([f], `clipboard-${Date.now()}.${ext}`, { type:f.type, lastModified:Date.now() }));
});
function resizeComposer() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}

function getSnippetQueryFromInput() {
  const value = input.value || "";
  const trimmedStart = value.trimStart();
  if (!trimmedStart.startsWith("#")) return null;
  const match = trimmedStart.match(/^#([^\s\n]*)/);
  return match ? normalizeShortcut(match[1]) : "";
}
function applyQuickReply(item) {
  if (!item) return;
  input.value = item.content || "";
  resizeComposer();
  hideSnippetMenu();
  input.focus();
}
function filteredQuickReplies(query = "") {
  const q = normalizeShortcut(query);
  const textNeedle = String(query || "").trim().toLowerCase();
  let items = quickReplies.filter(x => x.is_active !== false);
  if (!q && !textNeedle) return items;
  return items.filter(item => {
    const shortcut = String(item.shortcut || "").toLowerCase();
    const title = String(item.title || "").toLowerCase();
    const content = String(item.content || "").toLowerCase();
    return shortcut.includes(q) || title.includes(textNeedle) || content.includes(textNeedle);
  });
}
function renderSnippetMenu(items = []) {
  if (!items.length) {
    snippetMenu.innerHTML = `<div class="snippet-empty">Belum ada hashtag yang cocok.</div><button class="snippet-manage-link" type="button" data-open-snippet-manager="1">＋ Tambah / Edit Hashtag</button>`;
    snippetMenu.classList.remove("hidden");
    snippetMenuIndex = -1;
    return;
  }
  if (snippetMenuIndex >= items.length) snippetMenuIndex = 0;
  snippetMenu.innerHTML = items.map((item, idx) => `
    <button class="snippet-item ${idx===snippetMenuIndex?"active":""}" type="button" data-snippet-id="${esc(item.id)}">
      <div class="snippet-item-top"><span class="snippet-hash">#${esc(item.shortcut)}</span><span class="snippet-label">${esc(item.title || item.shortcut)}</span></div>
      <span class="snippet-preview">${esc(item.content || "")}</span>
    </button>`).join("") + `<button class="snippet-manage-link" type="button" data-open-snippet-manager="1">＋ Tambah / Edit Hashtag</button>`;
  snippetMenu.classList.remove("hidden");
}
function hideSnippetMenu() {
  snippetMenu.classList.add("hidden");
  snippetMenu.innerHTML = "";
  snippetMenuIndex = -1;
}
function updateSnippetMenu(force = false) {
  const query = getSnippetQueryFromInput();
  if (query === null && !force) return hideSnippetMenu();
  const items = filteredQuickReplies(force ? "" : query || "");
  if (snippetMenuIndex < 0 && items.length) snippetMenuIndex = 0;
  renderSnippetMenu(items);
}
async function ensureQuickRepliesLoaded(query = "") {
  const url = `/api/quick-replies?active=1&limit=150${query?`&query=${encodeURIComponent(query)}`:""}`;
  const d = await api(url);
  quickReplies = Array.isArray(d.items) ? d.items : [];
  return quickReplies;
}

input.addEventListener("input", async () => {
  resizeComposer();
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (!current || Date.now() - lastTypingAt < 2800) return;
    lastTypingAt = Date.now();
    api(`/api/conversations/${current.id}/typing`, { method:"POST", body:"{}" }).catch(() => {});
  }, 180);
  const query = getSnippetQueryFromInput();
  if (query !== null) {
    if (!quickReplies.length) {
      try { await ensureQuickRepliesLoaded(query); } catch (e) { console.warn("[QUICK_REPLY_LOAD_WARNING]", e.message); }
    }
    updateSnippetMenu(false);
  } else hideSnippetMenu();
});

snippetMenu.addEventListener("click", e => {
  const manage = e.target.closest("[data-open-snippet-manager]");
  if (manage) {
    hideSnippetMenu();
    openSnippetModal().catch(err => setStatusMessage(err.message, "error"));
    return;
  }
  const btn = e.target.closest("[data-snippet-id]");
  if (!btn) return;
  const item = quickReplies.find(x => x.id === btn.dataset.snippetId);
  applyQuickReply(item);
});

composer.addEventListener("submit", async e => {
  e.preventDefault();
  if (!current || isSending) return;
  const body = input.value.trim();
  if (!body && !selectedFile) return;

  const convId = current.id;
  const clientRequestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempId = `temp-${clientRequestId}`;
  const temp = {
    id: tempId,
    conversation_id: convId,
    direction:"out",
    message_type: selectedFile ? (String(selectedFile.type).split("/")[0] || "document") : "text",
    body: body || (selectedFile?.name || ""),
    status:"sending",
    created_at: new Date().toISOString(),
    _pending:true
  };
  currentMessages.push(temp);
  renderMessages(currentMessages, true);
  input.value = "";
  resizeComposer();
  hideSnippetMenu();
  const fileToSend = selectedFile;
  const replyToSend = replyTarget;
  clearReply();
  clearAttachment();
  isSending = true;
  sendBtn.disabled = true;
  attachBtn.disabled = true;
  hashtagBtn.disabled = true;
  sendError.classList.add("hidden");
  try {
    let result;
    if (fileToSend) {
      const fd = new FormData();
      fd.append("file", fileToSend);
      fd.append("caption", body);
      fd.append("clientRequestId", clientRequestId);
      if (replyToSend) fd.append("replyToMessageId", replyToSend.id);
      result = await api(`/api/conversations/${convId}/media`, { method:"POST", body:fd });
    } else {
      result = await api(`/api/conversations/${convId}/messages`, { method:"POST", body:JSON.stringify({ body, replyToMessageId: replyToSend?.id || null, clientRequestId }) });
    }
    currentMessages = currentMessages.filter(x => x.id !== tempId);
    if (result?.message) currentMessages = mergeMessages(currentMessages, [result.message]);
    messageCache.set(convId, currentMessages);
    if (current?.id === convId) renderMessages(currentMessages, true);
    const row = conversations.find(x => x.id === convId);
    if (row) {
      row.last_message_preview = body || fileToSend?.name || "[media]";
      row.last_message_at = new Date().toISOString();
      renderList();
    }
  } catch (err) {
    const t = currentMessages.find(x => x.id === tempId);
    if (t) {
      t._pending = false;
      t._failed = true;
      t.status = "failed";
    }
    renderMessages(currentMessages, true);
    const p = err.data?.provider;
    const detail = p?.message || p?.code || "";
    sendError.textContent = detail && detail !== err.message ? `${err.message} — ${detail}` : err.message;
    sendError.classList.remove("hidden");
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    hashtagBtn.disabled = false;
    input.focus();
  }
});

input.addEventListener("keydown", e => {
  if (!snippetMenu.classList.contains("hidden")) {
    const items = filteredQuickReplies(getSnippetQueryFromInput() || "");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) snippetMenuIndex = (snippetMenuIndex + 1 + items.length) % items.length;
      renderSnippetMenu(items);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) snippetMenuIndex = (snippetMenuIndex - 1 + items.length) % items.length;
      renderSnippetMenu(items);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const query = getSnippetQueryFromInput();
      if ((query !== null) && items[snippetMenuIndex >= 0 ? snippetMenuIndex : 0]) {
        e.preventDefault();
        applyQuickReply(items[snippetMenuIndex >= 0 ? snippetMenuIndex : 0]);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideSnippetMenu();
      return;
    }
  }
  if (e.key !== "Enter" || e.isComposing) return;
  if (e.shiftKey) return;
  e.preventDefault();
  if (!isSending) composer.requestSubmit();
});

document.addEventListener("click", e => {
  if (!e.target.closest(".wa-input-wrap") && !e.target.closest("#hashtagBtn")) hideSnippetMenu();
});

hashtagBtn.addEventListener("click", async () => {
  if (!quickReplies.length) {
    try { await ensureQuickRepliesLoaded(); } catch (e) { console.warn(e.message); }
  }
  input.focus();
  if (!String(input.value || "").trim()) {
    input.value = "#";
    resizeComposer();
  }
  updateSnippetMenu(true);
});

toggleStatus.addEventListener("click", async () => {
  if (!current) return;
  const status = current.status === "closed" ? "open" : "closed";
  await api(`/api/conversations/${current.id}/status`, { method:"POST", body:JSON.stringify({ status }) });
  current.status = status;
  updateHeader();
  scheduleConversationReload(0);
});
archiveBtn.addEventListener("click", async () => {
  if (!current) return;
  const archived = !Boolean(current.is_archived);
  await api(`/api/conversations/${current.id}/archive`, { method:"POST", body:JSON.stringify({ archived }) });
  current = null;
  chatView.classList.add("hidden");
  empty.classList.remove("hidden");
  chatPane.classList.remove("mobile-open");
  await loadConversations({ backgroundSync:false });
});
mobileBack.addEventListener("click", () => chatPane.classList.remove("mobile-open"));

async function loadQuickRepliesForManager(query = "") {
  const d = await api(`/api/quick-replies?active=0&limit=200${query?`&query=${encodeURIComponent(query)}`:""}`);
  quickReplies = Array.isArray(d.items) ? d.items : [];
  renderQuickReplyLibrary();
  return quickReplies;
}
function renderQuickReplyLibrary(activeId = snippetId.value || "") {
  const query = String(snippetSearch.value || "").trim().toLowerCase();
  const items = quickReplies.filter(item => {
    if (!query) return true;
    return [item.shortcut, item.title, item.content].join(" ").toLowerCase().includes(query);
  });
  snippetLibraryList.innerHTML = items.length ? items.map(item => `
    <div class="snippet-library-card ${activeId===item.id?"active":""}" data-edit-snippet="${esc(item.id)}">
      <div class="snippet-library-card-top">
        <div>
          <h4>#${esc(item.shortcut)} — ${esc(item.title || item.shortcut)}</h4>
          <small>Urutan ${Number(item.sort_order || 0)}</small>
        </div>
        <span class="snippet-badge ${item.is_active?"":"off"}">${item.is_active?"Aktif":"Nonaktif"}</span>
      </div>
      <p>${esc(item.content || "")}</p>
    </div>`).join("") : `<div class="snippet-empty">Belum ada hashtag. Klik + Baru untuk membuat balasan cepat.</div>`;
}
function resetSnippetForm() {
  snippetForm.reset();
  snippetId.value = "";
  snippetShortcut.value = "";
  snippetTitle.value = "";
  snippetSort.value = "0";
  snippetContent.value = "";
  snippetActive.checked = true;
  deleteSnippetBtn.classList.add("hidden");
  setStatusMessage();
}
function fillSnippetForm(item) {
  if (!item) return resetSnippetForm();
  snippetId.value = item.id || "";
  snippetShortcut.value = item.shortcut || "";
  snippetTitle.value = item.title || item.shortcut || "";
  snippetSort.value = String(Number(item.sort_order || 0));
  snippetContent.value = item.content || "";
  snippetActive.checked = item.is_active !== false;
  deleteSnippetBtn.classList.remove("hidden");
  setStatusMessage();
  renderQuickReplyLibrary(item.id || "");
}
async function openSnippetModal() {
  snippetModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  await loadQuickRepliesForManager();
  renderQuickReplyLibrary();
  if (!snippetId.value) resetSnippetForm();
}
async function closeSnippetModalFn() {
  snippetModal.classList.add("hidden");
  document.body.style.overflow = "";
  setStatusMessage();
  try { await ensureQuickRepliesLoaded(); } catch (e) { console.warn("[QUICK_REPLY_REFRESH_WARNING]", e.message); }
}
manageSnippetsBtn.addEventListener("click", () => openSnippetModal().catch(err => setStatusMessage(err.message, "error")));
closeSnippetModal.addEventListener("click", () => { closeSnippetModalFn().catch(console.warn); });
snippetModal.addEventListener("click", e => { if (e.target === snippetModal) closeSnippetModalFn().catch(console.warn); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !snippetModal.classList.contains("hidden")) closeSnippetModalFn().catch(console.warn); });

newSnippetBtn.addEventListener("click", () => {
  resetSnippetForm();
  snippetShortcut.focus();
  renderQuickReplyLibrary();
});
resetSnippetBtn.addEventListener("click", () => resetSnippetForm());
snippetSearch.addEventListener("input", () => {
  clearTimeout(snippetSearchTimer);
  snippetSearchTimer = setTimeout(() => renderQuickReplyLibrary(), 70);
});
snippetLibraryList.addEventListener("click", e => {
  const card = e.target.closest("[data-edit-snippet]");
  if (!card) return;
  const item = quickReplies.find(x => x.id === card.dataset.editSnippet);
  if (item) fillSnippetForm(item);
});

snippetForm.addEventListener("submit", async e => {
  e.preventDefault();
  const payload = {
    shortcut: normalizeShortcut(snippetShortcut.value),
    title: snippetTitle.value.trim(),
    sortOrder: Number(snippetSort.value || 0),
    content: snippetContent.value.trim(),
    isActive: snippetActive.checked
  };
  if (!payload.shortcut) return setStatusMessage("Hashtag wajib diisi.", "error");
  if (!payload.content) return setStatusMessage("Isi balasan hashtag wajib diisi.", "error");

  try {
    setStatusMessage("Menyimpan balasan hashtag...", "");
    let result;
    if (snippetId.value) {
      result = await api(`/api/quick-replies/${snippetId.value}`, { method:"PATCH", body:JSON.stringify(payload) });
    } else {
      result = await api(`/api/quick-replies`, { method:"POST", body:JSON.stringify(payload) });
    }
    await loadQuickRepliesForManager();
    const saved = result.item;
    fillSnippetForm(saved);
    setStatusMessage("Balasan hashtag berhasil disimpan.", "success");
  } catch (err) {
    setStatusMessage(err.message, "error");
  }
});

deleteSnippetBtn.addEventListener("click", async () => {
  if (!snippetId.value) return;
  if (!confirm("Hapus balasan hashtag ini?")) return;
  try {
    await api(`/api/quick-replies/${snippetId.value}`, { method:"DELETE" });
    await loadQuickRepliesForManager();
    resetSnippetForm();
    renderQuickReplyLibrary();
    setStatusMessage("Balasan hashtag berhasil dihapus.", "success");
  } catch (err) {
    setStatusMessage(err.message, "error");
  }
});

socket.on("connect", () => { document.body.dataset.socket = "connected"; });
socket.on("disconnect", () => { document.body.dataset.socket = "disconnected"; });
socket.on("connect_error", err => console.warn("[SOCKET]", err?.message || err));
socket.on("message:new", m => {
  if (current?.id === m.conversation_id) {
    currentMessages = mergeMessages(currentMessages, [m]);
    messageCache.set(current.id, currentMessages);
    renderMessages(currentMessages, true);
  }
  scheduleConversationReload(120);
});
socket.on("message:update", m => {
  if (current?.id === m.conversation_id) {
    currentMessages = mergeMessages(currentMessages, [m]);
    messageCache.set(current.id, currentMessages);
    const row = msgEl.querySelector(`[data-message-id="${CSS.escape(String(m.id || m.provider_message_id))}"]`);
    const statusEl = row?.querySelector(".status");
    if (statusEl && m.status) { const st = statusMeta(m.status); statusEl.textContent = st.text; statusEl.className = `status ${st.cls}`; statusEl.title = st.title; }
  }
  scheduleConversationReload(180);
});
socket.on("conversation:update", c => {
  if (c?.id) {
    const i = conversations.findIndex(x => x.id === c.id);
    if (i >= 0) conversations[i] = { ...conversations[i], ...c };
    if (current?.id === c.id) current = { ...current, ...c };
    renderList();
    updateHeader();
  } else scheduleConversationReload(150);
});
socket.on("conversation:refresh", () => scheduleConversationReload(180));

Promise.allSettled([
  loadConversations(),
  ensureQuickRepliesLoaded().catch(()=>[])
]).then(() => {
  if (!conversations.length) listEl.innerHTML ||= `<div class="list-empty">Belum ada percakapan.</div>`;
}).catch(err => {
  console.error(err);
  listEl.innerHTML = `<div class="list-empty">Gagal memuat percakapan.</div>`;
});
