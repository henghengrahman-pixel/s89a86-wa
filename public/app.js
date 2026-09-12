const socket=io({transports:["websocket","polling"]});
const $=s=>document.querySelector(s);
const listEl=$("#conversationList"),searchEl=$("#search"),empty=$("#emptyState"),chatView=$("#chatView"),chatPane=$(".wa-main");
const msgEl=$("#messages"),nameEl=$("#chatName"),phoneEl=$("#chatPhone"),composer=$("#composer"),input=$("#messageInput");
const sendBtn=$("#sendBtn"),sendError=$("#sendError"),toggleStatus=$("#toggleStatus"),archiveBtn=$("#archiveBtn"),mobileBack=$("#mobileBack");
const replyBar=$("#replyBar"),replyText=$("#replyText"),cancelReply=$("#cancelReply"),attachBtn=$("#attachBtn"),fileInput=$("#fileInput");
const attachmentBar=$("#attachmentBar"),attachmentName=$("#attachmentName"),attachmentPreview=$("#attachmentPreview"),cancelAttachment=$("#cancelAttachment");
const tabButtons=[...document.querySelectorAll(".wa-tab")];

let conversations=[],current=null,currentMessages=[],currentMode="inbox",replyTarget=null,selectedFile=null,isSending=false;
let openSeq=0,openController=null,listTimer=null,listLoading=false,pendingListReload=false,nextBefore=null,loadingOlder=false,typingTimer=null,lastTypingAt=0;
const messageCache=new Map();
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=t=>t?new Date(t).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}):"";
const initial=s=>(String(s||"?").trim()[0]||"?").toUpperCase();
const short=s=>String(s||"").replace(/\s+/g," ").trim().slice(0,90);

async function api(url,opt={}){
  const headers={...(opt.headers||{})};
  if(opt.body && !(opt.body instanceof FormData)) headers["content-type"]="application/json";
  const r=await fetch(url,{...opt,headers,credentials:"same-origin"});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(data.error||`HTTP ${r.status}`),{data,status:r.status});
  return data;
}

function renderList(){
  const q=searchEl.value.trim().toLowerCase();
  const rows=conversations.filter(c=>[c.display_name,c.profile_name,c.phone,c.last_message_preview].join(" ").toLowerCase().includes(q));
  listEl.innerHTML=rows.length?rows.map(c=>`
    <div class="conv ${current?.id===c.id?"active":""}" data-id="${esc(c.id)}">
      <div class="conv-avatar">${esc(initial(c.display_name||c.phone))}</div>
      <div class="conv-main"><div class="conv-top"><div class="conv-name">${esc(c.display_name||c.profile_name||c.phone)}</div><div class="conv-time">${fmt(c.last_message_at)}</div></div>
      <div class="conv-bottom"><div class="conv-preview">${esc(c.last_message_preview||"Belum ada pesan")}</div>${Number(c.unread_count)>0?`<span class="unread">${Number(c.unread_count)>99?"99+":Number(c.unread_count)}</span>`:""}</div></div>
    </div>`).join(""):`<div class="list-empty">${currentMode==="archived"?"Belum ada chat di arsip.":"Belum ada percakapan."}</div>`;
}

async function loadConversations({backgroundSync=true}={}){
  if(listLoading){pendingListReload=true;return;}
  listLoading=true;
  try{
    const d=await api(`/api/conversations?archived=${currentMode==="archived"?"1":"0"}&limit=50&sync=${backgroundSync?"1":"0"}`);
    conversations=Array.isArray(d.conversations)?d.conversations:[];
    if(current){const fresh=conversations.find(x=>x.id===current.id);if(fresh)current={...current,...fresh};}
    renderList();
  }finally{
    listLoading=false;
    if(pendingListReload){pendingListReload=false;scheduleConversationReload(120);}
  }
}
function scheduleConversationReload(delay=250){clearTimeout(listTimer);listTimer=setTimeout(()=>loadConversations({backgroundSync:false}).catch(console.error),delay);}

listEl.addEventListener("click",e=>{const row=e.target.closest(".conv");if(row)openConversation(row.dataset.id);});
let searchTimer=null;searchEl.addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(renderList,60);});
tabButtons.forEach(btn=>btn.addEventListener("click",()=>{currentMode=btn.dataset.mode;tabButtons.forEach(x=>x.classList.toggle("active",x===btn));current=null;chatView.classList.add("hidden");empty.classList.remove("hidden");chatPane.classList.remove("mobile-open");loadConversations().catch(console.error);}));

function updateHeader(){
  if(!current)return;
  nameEl.textContent=current.display_name||current.profile_name||current.phone||"-";
  phoneEl.textContent=current.phone||"";
  toggleStatus.textContent=current.status==="closed"?"Buka chat":"Tutup chat";
  archiveBtn.title=current.is_archived?"Keluarkan dari arsip":"Arsipkan chat";
  archiveBtn.textContent=current.is_archived?"↥":"⌄";
}
function mergeMessages(base,incoming){
  const map=new Map();
  for(const m of [...(base||[]),...(incoming||[])]){
    if(!m)continue;const key=m.id||m.provider_message_id;if(!key)continue;map.set(String(key),{...(map.get(String(key))||{}),...m});
  }
  return [...map.values()].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
}

async function openConversation(id){
  const seq=++openSeq; nextBefore=null; loadingOlder=false;
  const local=conversations.find(x=>x.id===id); if(local)current={...local};
  empty.classList.add("hidden");chatView.classList.remove("hidden");chatPane.classList.add("mobile-open");clearReply();clearAttachment();updateHeader();renderList();
  const cached=messageCache.get(id);
  if(cached?.length){currentMessages=cached;renderMessages(cached,true);}else msgEl.innerHTML=`<div class="chat-loading"><span></span><span></span><span></span></div>`;
  openController?.abort(); const controller=new AbortController();openController=controller;
  try{
    const d=await api(`/api/conversations/${id}/messages?limit=50&sync=1`,{signal:controller.signal}); if(seq!==openSeq)return;
    current=d.conversation;nextBefore=d.nextBefore||null;currentMessages=mergeMessages([],d.messages||[]);messageCache.set(id,currentMessages);updateHeader();renderMessages(currentMessages,true);
    const row=conversations.find(x=>x.id===id);if(row)row.unread_count=0;renderList();
    api(`/api/conversations/${id}/read`,{method:"POST",body:"{}"}).catch(()=>{});
    // Revalidasi langsung dari provider di belakang layar. UI tidak menunggu proses ini.
    api(`/api/conversations/${id}/sync-messages`,{method:"POST",body:JSON.stringify({limit:50})})
      .then(()=>api(`/api/conversations/${id}/messages?limit=50&sync=0`))
      .then(fresh=>{if(seq!==openSeq||current?.id!==id)return;current=fresh.conversation;nextBefore=fresh.nextBefore||nextBefore;currentMessages=mergeMessages(currentMessages,fresh.messages||[]);messageCache.set(id,currentMessages);updateHeader();renderMessages(currentMessages,true);})
      .catch(err=>console.warn("[DIRECT_SYNC_WARNING]",err.message));
  }catch(err){
    if(err?.name==="AbortError"||seq!==openSeq)return;
    if(cached?.length){console.warn("[OPEN_CHAT_STALE_CACHE]",err.message);return;}
    msgEl.innerHTML=`<div class="chat-load-error">Chat gagal dimuat. <button type="button" id="retryChat">Coba lagi</button></div>`;$("#retryChat")?.addEventListener("click",()=>openConversation(id));
  }finally{if(openController===controller)openController=null;}
}

async function loadOlderMessages(){
  if(!current||!nextBefore||loadingOlder)return;loadingOlder=true;
  const oldHeight=msgEl.scrollHeight,oldTop=msgEl.scrollTop;
  try{
    const d=await api(`/api/conversations/${current.id}/messages?limit=50&sync=0&before=${encodeURIComponent(nextBefore)}`);
    nextBefore=d.nextBefore||null;currentMessages=mergeMessages(d.messages||[],currentMessages);messageCache.set(current.id,currentMessages);renderMessages(currentMessages,false);
    requestAnimationFrame(()=>{msgEl.scrollTop=msgEl.scrollHeight-oldHeight+oldTop;});
  }catch(e){console.warn("[LOAD_OLDER_WARNING]",e.message);}finally{loadingOlder=false;}
}
msgEl.addEventListener("scroll",()=>{if(msgEl.scrollTop<90)loadOlderMessages();},{passive:true});

function mediaMarkup(m){
  if(!m.media_url)return"";const type=String(m.message_type||"").toLowerCase();const u=esc(m.media_url);
  if(type==="image")return`<a href="${u}" target="_blank" rel="noopener"><img class="msg-media" loading="lazy" decoding="async" src="${u}" alt="Gambar"></a>`;
  if(type==="video")return`<video class="msg-media" controls preload="metadata" src="${u}"></video>`;
  if(type==="audio")return`<audio controls preload="none" src="${u}"></audio>`;
  return`<a class="doc-card" href="${u}" target="_blank" rel="noopener"><span class="doc-icon">📄</span><span>${esc(m.body||"Buka dokumen")}</span></a>`;
}
function messageHtml(m,prev){
  const direction=m.direction==="out"?"out":"in";const senderSwitch=prev&&prev.direction!==m.direction?" sender-switch":"";
  const bodyHtml=m.body&&!(m.media_url&&String(m.message_type).toLowerCase()==="document")?`<span class="bubble-text">${esc(m.body)}</span>`:"";
  const pending=m._pending?" pending":"",failed=m._failed?" failed":"";
  return `<div class="message-row ${direction}${senderSwitch}${pending}${failed}" data-message-id="${esc(m.id||m.provider_message_id)}"><div class="bubble-wrap">
    ${!m._pending?`<button class="reply-btn" type="button" data-reply="${esc(m.id)}" title="Balas pesan">↩</button>`:""}<div class="bubble">
    ${m.reply_to_message_id?`<div class="reply-quote"><strong>${m.reply_direction==="out"?"Anda":"Member"}</strong>${esc(short(m.reply_body||`[${m.reply_message_type||"pesan"}]`))}</div>`:""}
    ${mediaMarkup(m)}${bodyHtml}<span class="bubble-meta">${fmt(m.created_at)} ${direction==="out"?`<span class="status">${esc(m._failed?"gagal":m._pending?"mengirim…":m.status||"sent")}</span>`:""}</span></div></div></div>`;
}
function renderMessages(messages,scrollBottom=false){
  const visible=(Array.isArray(messages)?messages:[]).filter(m=>m&&(m.id||m.provider_message_id));currentMessages=visible;
  if(!visible.length){msgEl.innerHTML=`<div class="chat-empty-messages">Belum ada pesan pada percakapan ini.</div>`;return;}
  msgEl.innerHTML=visible.map((m,i)=>messageHtml(m,visible[i-1])).join("");
  if(scrollBottom)requestAnimationFrame(()=>{msgEl.scrollTop=msgEl.scrollHeight;});
}
msgEl.addEventListener("click",e=>{const btn=e.target.closest("[data-reply]");if(!btn)return;const m=currentMessages.find(x=>x.id===btn.dataset.reply);if(!m)return;replyTarget=m;replyText.textContent=short(m.body||`[${m.message_type}]`);replyBar.classList.remove("hidden");input.focus();});
function clearReply(){replyTarget=null;replyBar.classList.add("hidden");replyText.textContent="";}cancelReply.addEventListener("click",clearReply);

function setSelectedFile(file){
  if(!file)return;const maxBytes=20*1024*1024;if(file.size>maxBytes){sendError.textContent="Ukuran file maksimal 20 MB.";sendError.classList.remove("hidden");return;}
  sendError.classList.add("hidden");selectedFile=file;attachmentName.textContent=`${file.name} • ${(file.size/1024/1024).toFixed(2)} MB`;
  if(attachmentPreview){attachmentPreview.innerHTML="";if(String(file.type||"").startsWith("image/")){const url=URL.createObjectURL(file),img=document.createElement("img");img.src=url;img.alt="Preview";img.onload=()=>URL.revokeObjectURL(url);attachmentPreview.appendChild(img);}}
  attachmentBar.classList.remove("hidden");input.placeholder="Tambahkan caption (opsional)";
}
attachBtn.addEventListener("click",()=>fileInput.click());fileInput.addEventListener("change",()=>{const f=fileInput.files?.[0];if(f)setSelectedFile(f);});
function clearAttachment(){selectedFile=null;fileInput.value="";attachmentBar.classList.add("hidden");attachmentName.textContent="";if(attachmentPreview)attachmentPreview.innerHTML="";input.placeholder="Ketik pesan";}cancelAttachment.addEventListener("click",clearAttachment);
input.addEventListener("paste",e=>{const item=[...(e.clipboardData?.items||[])].find(x=>x.kind==="file"&&String(x.type||"").startsWith("image/"));if(!item)return;const f=item.getAsFile();if(!f)return;e.preventDefault();const ext=(f.type.split("/")[1]||"png").replace("jpeg","jpg");setSelectedFile(new File([f],`clipboard-${Date.now()}.${ext}`,{type:f.type,lastModified:Date.now()}));});
function resizeComposer(){input.style.height="auto";input.style.height=Math.min(input.scrollHeight,120)+"px";}
input.addEventListener("input",()=>{resizeComposer();clearTimeout(typingTimer);typingTimer=setTimeout(()=>{if(!current||Date.now()-lastTypingAt<2800)return;lastTypingAt=Date.now();api(`/api/conversations/${current.id}/typing`,{method:"POST",body:"{}"}).catch(()=>{});},180);});

composer.addEventListener("submit",async e=>{
  e.preventDefault();if(!current||isSending)return;const body=input.value.trim();if(!body&&!selectedFile)return;
  const convId=current.id,clientRequestId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempId=`temp-${clientRequestId}`;const temp={id:tempId,conversation_id:convId,direction:"out",message_type:selectedFile?(String(selectedFile.type).split("/")[0]||"document"):"text",body:body||(selectedFile?.name||""),status:"sending",created_at:new Date().toISOString(),_pending:true};
  currentMessages.push(temp);renderMessages(currentMessages,true);input.value="";resizeComposer();const fileToSend=selectedFile,replyToSend=replyTarget;clearReply();clearAttachment();
  isSending=true;sendBtn.disabled=true;attachBtn.disabled=true;sendError.classList.add("hidden");
  try{
    let result;if(fileToSend){const fd=new FormData();fd.append("file",fileToSend);fd.append("caption",body);fd.append("clientRequestId",clientRequestId);if(replyToSend)fd.append("replyToMessageId",replyToSend.id);result=await api(`/api/conversations/${convId}/media`,{method:"POST",body:fd});}
    else result=await api(`/api/conversations/${convId}/messages`,{method:"POST",body:JSON.stringify({body,replyToMessageId:replyToSend?.id||null,clientRequestId})});
    currentMessages=currentMessages.filter(x=>x.id!==tempId);if(result?.message)currentMessages=mergeMessages(currentMessages,[result.message]);messageCache.set(convId,currentMessages);if(current?.id===convId)renderMessages(currentMessages,true);
    const row=conversations.find(x=>x.id===convId);if(row){row.last_message_preview=body||fileToSend?.name||"[media]";row.last_message_at=new Date().toISOString();renderList();}
  }catch(err){const t=currentMessages.find(x=>x.id===tempId);if(t){t._pending=false;t._failed=true;t.status="failed";}renderMessages(currentMessages,true);const p=err.data?.provider,detail=p?.message||p?.code||"";sendError.textContent=detail&&detail!==err.message?`${err.message} — ${detail}`:err.message;sendError.classList.remove("hidden");}
  finally{isSending=false;sendBtn.disabled=false;attachBtn.disabled=false;input.focus();}
});
input.addEventListener("keydown",e=>{if(e.key!=="Enter"||e.isComposing)return;if(e.shiftKey)return;e.preventDefault();if(!isSending)composer.requestSubmit();});

toggleStatus.addEventListener("click",async()=>{if(!current)return;const status=current.status==="closed"?"open":"closed";await api(`/api/conversations/${current.id}/status`,{method:"POST",body:JSON.stringify({status})});current.status=status;updateHeader();scheduleConversationReload(0);});
archiveBtn.addEventListener("click",async()=>{if(!current)return;const archived=!Boolean(current.is_archived);await api(`/api/conversations/${current.id}/archive`,{method:"POST",body:JSON.stringify({archived})});current=null;chatView.classList.add("hidden");empty.classList.remove("hidden");chatPane.classList.remove("mobile-open");await loadConversations({backgroundSync:false});});
mobileBack.addEventListener("click",()=>chatPane.classList.remove("mobile-open"));

socket.on("connect",()=>{document.body.dataset.socket="connected";});socket.on("disconnect",()=>{document.body.dataset.socket="disconnected";});socket.on("connect_error",err=>console.warn("[SOCKET]",err?.message||err));
socket.on("message:new",m=>{if(current?.id===m.conversation_id){currentMessages=mergeMessages(currentMessages,[m]);messageCache.set(current.id,currentMessages);renderMessages(currentMessages,true);}scheduleConversationReload(120);});
socket.on("message:update",m=>{if(current?.id===m.conversation_id){currentMessages=mergeMessages(currentMessages,[m]);messageCache.set(current.id,currentMessages);const row=msgEl.querySelector(`[data-message-id="${CSS.escape(String(m.id||m.provider_message_id))}"]`),statusEl=row?.querySelector(".status");if(statusEl&&m.status)statusEl.textContent=m.status;}scheduleConversationReload(180);});
socket.on("conversation:update",c=>{if(c?.id){const i=conversations.findIndex(x=>x.id===c.id);if(i>=0)conversations[i]={...conversations[i],...c};if(current?.id===c.id)current={...current,...c};renderList();updateHeader();}else scheduleConversationReload(150);});
socket.on("conversation:refresh",()=>scheduleConversationReload(180));

loadConversations().catch(err=>{console.error(err);listEl.innerHTML=`<div class="list-empty">Gagal memuat percakapan.</div>`;});
