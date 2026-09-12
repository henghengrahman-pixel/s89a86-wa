const socket=io();
const listEl=document.querySelector("#conversationList");
const searchEl=document.querySelector("#search");
const empty=document.querySelector("#emptyState");
const chatView=document.querySelector("#chatView");
const chatPane=document.querySelector(".wa-main");
const msgEl=document.querySelector("#messages");
const nameEl=document.querySelector("#chatName");
const phoneEl=document.querySelector("#chatPhone");
const composer=document.querySelector("#composer");
const input=document.querySelector("#messageInput");
const sendBtn=document.querySelector("#sendBtn");
const sendError=document.querySelector("#sendError");
const toggleStatus=document.querySelector("#toggleStatus");
const archiveBtn=document.querySelector("#archiveBtn");
const mobileBack=document.querySelector("#mobileBack");
const replyBar=document.querySelector("#replyBar");
const replyText=document.querySelector("#replyText");
const cancelReply=document.querySelector("#cancelReply");
const attachBtn=document.querySelector("#attachBtn");
const fileInput=document.querySelector("#fileInput");
const attachmentBar=document.querySelector("#attachmentBar");
const attachmentName=document.querySelector("#attachmentName");
const attachmentPreview=document.querySelector("#attachmentPreview");
const cancelAttachment=document.querySelector("#cancelAttachment");
const tabButtons=[...document.querySelectorAll(".wa-tab")];

let conversations=[];
let current=null;
let currentMessages=[];
let currentMode="inbox";
let replyTarget=null;
let selectedFile=null;
let isSending=false;
let openSeq=0;
let listTimer=null;
let listLoading=false;
let pendingListReload=false;

const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=t=>t?new Date(t).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}):"";
const initial=s=>(String(s||"?").trim()[0]||"?").toUpperCase();
const short=s=>String(s||"").replace(/\s+/g," ").trim().slice(0,90);

async function api(url,opt={}){
  const headers={...(opt.headers||{})};
  if(opt.body && !(opt.body instanceof FormData)) headers["content-type"]="application/json";
  const r=await fetch(url,{...opt,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(data.error||`HTTP ${r.status}`),{data});
  return data;
}

async function loadConversations(){
  if(listLoading){
    pendingListReload=true;
    return;
  }

  listLoading=true;
  try{
    const d=await api(`/api/conversations?archived=${currentMode==="archived"?"1":"0"}`);
    conversations=d.conversations;
    renderList();

    if(current){
      const fresh=conversations.find(x=>x.id===current.id);
      if(fresh) current={...current,...fresh};
    }
  }finally{
    listLoading=false;
    if(pendingListReload){
      pendingListReload=false;
      scheduleConversationReload(120);
    }
  }
}

function scheduleConversationReload(delay=120){
  clearTimeout(listTimer);
  listTimer=setTimeout(()=>loadConversations().catch(console.error),delay);
}

function renderList(){
  const q=searchEl.value.trim().toLowerCase();
  const rows=conversations.filter(c=>[c.display_name,c.profile_name,c.phone,c.last_message_preview].join(" ").toLowerCase().includes(q));
  listEl.innerHTML=rows.length?rows.map(c=>`
    <div class="conv ${current?.id===c.id?"active":""}" data-id="${c.id}">
      <div class="conv-avatar">${esc(initial(c.display_name||c.phone))}</div>
      <div class="conv-main">
        <div class="conv-top">
          <div class="conv-name">${esc(c.display_name||c.profile_name||c.phone)}</div>
          <div class="conv-time">${fmt(c.last_message_at)}</div>
        </div>
        <div class="conv-bottom">
          <div class="conv-preview">${esc(c.last_message_preview||"Belum ada pesan")}</div>
          ${c.unread_count?`<span class="unread">${c.unread_count}</span>`:""}
        </div>
      </div>
    </div>`).join(""):`<div style="padding:28px 18px;color:#8696a0;text-align:center">${currentMode==="archived"?"Belum ada chat di arsip.":"Belum ada percakapan."}</div>`;
}

listEl.addEventListener("click",e=>{
  const row=e.target.closest(".conv");
  if(row) openConversation(row.dataset.id);
});
searchEl.addEventListener("input",renderList);

tabButtons.forEach(btn=>btn.addEventListener("click",()=>{
  currentMode=btn.dataset.mode;
  tabButtons.forEach(x=>x.classList.toggle("active",x===btn));
  current=null;
  chatView.classList.add("hidden");
  empty.classList.remove("hidden");
  chatPane.classList.remove("mobile-open");
  scheduleConversationReload(0);
}));

async function openConversation(id,{keepScroll=false}={}){
  const seq=++openSeq;
  const previousScroll=msgEl.scrollTop;
  const d=await api(`/api/conversations/${id}/messages`);
  if(seq!==openSeq) return;

  current=d.conversation;
  currentMessages=d.messages;

  empty.classList.add("hidden");
  chatView.classList.remove("hidden");
  chatPane.classList.add("mobile-open");

  nameEl.textContent=current.display_name||current.profile_name||current.phone;
  phoneEl.textContent=current.phone;
  toggleStatus.textContent=current.status==="closed"?"Buka chat":"Tutup chat";
  archiveBtn.title=current.is_archived?"Keluarkan dari arsip":"Arsipkan chat";
  archiveBtn.textContent=current.is_archived?"↥":"⌄";

  clearReply();
  clearAttachment();
  renderMessages(currentMessages);

  if(keepScroll){
    requestAnimationFrame(()=>{ msgEl.scrollTop=previousScroll; });
  }

  api(`/api/conversations/${id}/read`,{method:"POST",body:"{}"}).catch(()=>{});
  scheduleConversationReload(80);
}

function mediaMarkup(m){
  if(!m.media_url) return "";
  const type=String(m.message_type||"").toLowerCase();
  if(type==="image") return `<a href="${esc(m.media_url)}" target="_blank" rel="noopener"><img class="msg-media" src="${esc(m.media_url)}" alt="Gambar"></a>`;
  if(type==="video") return `<video class="msg-media" controls preload="metadata" src="${esc(m.media_url)}"></video>`;
  if(type==="audio") return `<audio controls preload="metadata" src="${esc(m.media_url)}"></audio>`;
  return `<a class="doc-card" href="${esc(m.media_url)}" target="_blank" rel="noopener"><span class="doc-icon">📄</span><span>${esc(m.body||"Buka dokumen")}</span></a>`;
}

function renderMessages(messages){
  const source=Array.isArray(messages)?messages:[];
  const visible=[];

  for(const m of source){
    if(!m || !m.id) continue;

    const prev=visible[visible.length-1];
    const sameBody=prev &&
      m.direction==="out" &&
      prev.direction==="out" &&
      String(prev.body||"")===String(m.body||"") &&
      String(prev.media_url||"")===String(m.media_url||"");
    const closeInTime=prev &&
      Math.abs(new Date(m.created_at).getTime()-new Date(prev.created_at).getTime())<=3000;

    if(sameBody && closeInTime) continue;
    visible.push(m);
  }

  currentMessages=visible;

  if(!visible.length){
    msgEl.innerHTML=`<div class="chat-empty-messages">Belum ada pesan pada percakapan ini.</div>`;
    return;
  }

  const html=[];
  for(let i=0;i<visible.length;i++){
    const m=visible[i];
    const prev=visible[i-1];
    const direction=m.direction==="out"?"out":"in";
    const senderSwitch=prev && prev.direction!==m.direction ? " sender-switch" : "";
    const bodyHtml=m.body && !(m.media_url && String(m.message_type).toLowerCase()==="document")
      ? `<span class="bubble-text">${esc(m.body)}</span>`
      : "";

    html.push(`
      <div class="message-row ${direction}${senderSwitch}" data-message-id="${esc(m.id)}">
        <div class="bubble-wrap">
          <button class="reply-btn" type="button" data-reply="${esc(m.id)}" title="Balas pesan">↩</button>
          <div class="bubble">
            ${m.reply_to_message_id
              ? `<div class="reply-quote"><strong>${m.reply_direction==="out"?"Anda":"Member"}</strong>${esc(short(m.reply_body||`[${m.reply_message_type||"pesan"}]`))}</div>`
              : ""}
            ${mediaMarkup(m)}
            ${bodyHtml}
            <span class="bubble-meta">${fmt(m.created_at)} ${direction==="out"?`<span class="status">${esc(m.status||"sent")}</span>`:""}</span>
          </div>
        </div>
      </div>
    `);
  }

  msgEl.innerHTML=html.join("");

  requestAnimationFrame(()=>{
    msgEl.scrollTop=msgEl.scrollHeight;
  });
}

msgEl.addEventListener("click",e=>{
  const btn=e.target.closest("[data-reply]");
  if(!btn)return;
  const m=currentMessages.find(x=>x.id===btn.dataset.reply);
  if(!m)return;
  replyTarget=m;
  replyText.textContent=short(m.body||`[${m.message_type}]`);
  replyBar.classList.remove("hidden");
  input.focus();
});

function clearReply(){ replyTarget=null; replyBar.classList.add("hidden"); replyText.textContent=""; }
cancelReply.addEventListener("click",clearReply);

function setSelectedFile(file){
  if(!file) return;
  selectedFile=file;
  const mb=(file.size/1024/1024).toFixed(2);
  attachmentName.textContent=`${file.name} • ${mb} MB`;
  attachmentPreview.innerHTML="";
  if(String(file.type||"").startsWith("image/")){
    const url=URL.createObjectURL(file);
    const img=document.createElement("img");
    img.src=url;
    img.alt="Preview";
    img.onload=()=>URL.revokeObjectURL(url);
    attachmentPreview.appendChild(img);
  }
  attachmentBar.classList.remove("hidden");
  input.placeholder="Tambahkan caption (opsional)";
}

attachBtn.addEventListener("click",()=>fileInput.click());
fileInput.addEventListener("change",()=>{
  const file=fileInput.files?.[0]||null;
  if(file) setSelectedFile(file);
});

function clearAttachment(){
  selectedFile=null;
  fileInput.value="";
  attachmentBar.classList.add("hidden");
  attachmentName.textContent="";
  attachmentPreview.innerHTML="";
  input.placeholder="Ketik pesan";
}
cancelAttachment.addEventListener("click",clearAttachment);

// Paste gambar langsung dari clipboard (Ctrl+V / screenshot copy)
input.addEventListener("paste",e=>{
  const items=[...(e.clipboardData?.items||[])];
  const imageItem=items.find(item=>item.kind==="file" && String(item.type||"").startsWith("image/"));
  if(!imageItem) return;

  const file=imageItem.getAsFile();
  if(!file) return;

  e.preventDefault();
  const ext=(file.type.split("/")[1]||"png").replace("jpeg","jpg");
  const namedFile=new File(
    [file],
    `clipboard-${new Date().toISOString().replace(/[:.]/g,"-")}.${ext}`,
    {type:file.type,lastModified:Date.now()}
  );
  setSelectedFile(namedFile);
});

function resizeComposer(){
  input.style.height="auto";
  input.style.height=Math.min(input.scrollHeight,120)+"px";
}
input.addEventListener("input",resizeComposer);

composer.addEventListener("submit",async e=>{
  e.preventDefault();
  if(!current || isSending) return;

  const body=input.value.trim();
  if(!body && !selectedFile) return;

  isSending=true;
  sendBtn.disabled=true;
  attachBtn.disabled=true;
  sendError.classList.add("hidden");

  const clientRequestId=(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  try{
    let result;
    if(selectedFile){
      const fd=new FormData();
      fd.append("file",selectedFile);
      fd.append("caption",body);
      fd.append("clientRequestId",clientRequestId);
      if(replyTarget) fd.append("replyToMessageId",replyTarget.id);

      result=await api(`/api/conversations/${current.id}/media`,{
        method:"POST",
        body:fd
      });
      clearAttachment();
    }else{
      result=await api(`/api/conversations/${current.id}/messages`,{
        method:"POST",
        body:JSON.stringify({
          body,
          replyToMessageId:replyTarget?.id||null,
          clientRequestId
        })
      });
    }

    if(result?.message && current?.id===result.message.conversation_id){
      const exists=currentMessages.some(x=>
        x.id===result.message.id ||
        (result.message.provider_message_id && x.provider_message_id===result.message.provider_message_id)
      );
      if(!exists){
        currentMessages.push(result.message);
        currentMessages.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
        renderMessages(currentMessages);
      }
    }

    input.value="";
    resizeComposer();
    clearReply();
    scheduleConversationReload(80);
  }catch(err){
    const p=err.data?.provider;
    const detail=p?.message || p?.code || "";
    sendError.textContent=detail && detail!==err.message ? `${err.message} — ${detail}` : err.message;
    sendError.classList.remove("hidden");
  }finally{
    isSending=false;
    sendBtn.disabled=false;
    attachBtn.disabled=false;
    input.focus();
  }
});

input.addEventListener("keydown",e=>{
  if(e.key!=="Enter" || e.isComposing) return;

  if(e.shiftKey){
    // Shift+Enter = baris baru, biarkan browser bekerja normal.
    return;
  }

  // Enter = kirim satu kali.
  e.preventDefault();
  if(!isSending) composer.requestSubmit();
});

toggleStatus.addEventListener("click",async()=>{
  if(!current)return;
  const status=current.status==="closed"?"open":"closed";
  await api(`/api/conversations/${current.id}/status`,{method:"POST",body:JSON.stringify({status})});
  current.status=status;
  toggleStatus.textContent=status==="closed"?"Buka chat":"Tutup chat";
  loadConversations();
});

archiveBtn.addEventListener("click",async()=>{
  if(!current)return;
  const archived=!Boolean(current.is_archived);
  await api(`/api/conversations/${current.id}/archive`,{method:"POST",body:JSON.stringify({archived})});
  current=null;
  chatView.classList.add("hidden");
  empty.classList.remove("hidden");
  chatPane.classList.remove("mobile-open");
  await loadConversations();
});

mobileBack.addEventListener("click",()=>chatPane.classList.remove("mobile-open"));


socket.on("connect",()=>{
  document.body.dataset.socket="connected";
});
socket.on("disconnect",()=>{
  document.body.dataset.socket="disconnected";
});
socket.on("connect_error",err=>{
  console.warn("[SOCKET_CONNECT_ERROR]",err?.message||err);
});

socket.on("message:new",m=>{
  if(current?.id===m.conversation_id){
    const exists=currentMessages.some(x=>x.id===m.id || (
      m.provider_message_id && x.provider_message_id===m.provider_message_id
    ));
    if(!exists){
      currentMessages.push(m);
      currentMessages.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
      renderMessages(currentMessages);
    }
  }
  scheduleConversationReload(100);
});

socket.on("message:update",m=>{
  if(current?.id===m.conversation_id){
    const idx=currentMessages.findIndex(x=>x.id===m.id || (
      m.provider_message_id && x.provider_message_id===m.provider_message_id
    ));
    if(idx>=0){
      currentMessages[idx]={...currentMessages[idx],...m};
      renderMessages(currentMessages);
    }
  }
  scheduleConversationReload(150);
});

socket.on("conversation:refresh",()=>scheduleConversationReload(120));
socket.on("conversation:update",()=>scheduleConversationReload(120));

scheduleConversationReload(0);
