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
const cancelAttachment=document.querySelector("#cancelAttachment");
const tabButtons=[...document.querySelectorAll(".wa-tab")];

let conversations=[];
let current=null;
let currentMessages=[];
let currentMode="inbox";
let replyTarget=null;
let selectedFile=null;

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
  const d=await api(`/api/conversations?archived=${currentMode==="archived"?"1":"0"}`);
  conversations=d.conversations;
  renderList();
  if(current){
    const fresh=conversations.find(x=>x.id===current.id);
    if(fresh) current={...current,...fresh};
  }
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
  loadConversations();
}));

async function openConversation(id){
  const d=await api(`/api/conversations/${id}/messages`);
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
  await api(`/api/conversations/${id}/read`,{method:"POST",body:"{}"}).catch(()=>{});
  loadConversations();
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
  msgEl.innerHTML=messages.map(m=>`
    <div class="message-row ${m.direction}">
      <div class="bubble-wrap">
        <button class="reply-btn" type="button" data-reply="${m.id}" title="Balas pesan">↩</button>
        <div class="bubble">
          ${m.reply_to_message_id?`<div class="reply-quote"><strong>${m.reply_direction==="out"?"Anda":"Member"}</strong>${esc(short(m.reply_body||`[${m.reply_message_type||"pesan"}]`))}</div>`:""}
          ${mediaMarkup(m)}
          ${m.body && !(m.media_url && ["document"].includes(String(m.message_type).toLowerCase()))?`<span class="bubble-text">${esc(m.body)}</span>`:""}
          <div class="bubble-meta">${fmt(m.created_at)} ${m.direction==="out"?`<span class="status">${esc(m.status||"sent")}</span>`:""}</div>
        </div>
      </div>
    </div>`).join("");
  msgEl.scrollTop=msgEl.scrollHeight;
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

attachBtn.addEventListener("click",()=>fileInput.click());
fileInput.addEventListener("change",()=>{
  selectedFile=fileInput.files?.[0]||null;
  if(selectedFile){
    attachmentName.textContent=`${selectedFile.name} • ${(selectedFile.size/1024/1024).toFixed(2)} MB`;
    attachmentBar.classList.remove("hidden");
    input.placeholder="Tambahkan caption (opsional)";
  }
});
function clearAttachment(){
  selectedFile=null; fileInput.value=""; attachmentBar.classList.add("hidden");
  attachmentName.textContent=""; input.placeholder="Ketik pesan";
}
cancelAttachment.addEventListener("click",clearAttachment);

function resizeComposer(){
  input.style.height="auto";
  input.style.height=Math.min(input.scrollHeight,120)+"px";
}
input.addEventListener("input",resizeComposer);

composer.addEventListener("submit",async e=>{
  e.preventDefault();
  if(!current)return;
  const body=input.value.trim();
  if(!body && !selectedFile)return;

  sendBtn.disabled=true;
  sendError.classList.add("hidden");
  try{
    if(selectedFile){
      const fd=new FormData();
      fd.append("file",selectedFile);
      fd.append("caption",body);
      if(replyTarget) fd.append("replyToMessageId",replyTarget.id);
      await api(`/api/conversations/${current.id}/media`,{method:"POST",body:fd});
      clearAttachment();
    }else{
      await api(`/api/conversations/${current.id}/messages`,{
        method:"POST",
        body:JSON.stringify({body,replyToMessageId:replyTarget?.id||null})
      });
    }
    input.value="";
    resizeComposer();
    clearReply();
    await openConversation(current.id);
  }catch(err){
    {
      const p=err.data?.provider;
      const detail=p?.message || p?.code || "";
      sendError.textContent=detail && detail!==err.message ? `${err.message} — ${detail}` : err.message;
    }
    sendError.classList.remove("hidden");
  }finally{
    sendBtn.disabled=false;
    input.focus();
  }
});

input.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&!e.shiftKey){
    e.preventDefault();
    composer.requestSubmit();
  }
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

socket.on("message:new",m=>{
  loadConversations();
  if(current?.id===m.conversation_id) openConversation(current.id);
});
socket.on("message:update",m=>{if(current?.id===m.conversation_id)openConversation(current.id)});
socket.on("conversation:refresh",()=>loadConversations());
socket.on("conversation:update",()=>loadConversations());

loadConversations().catch(console.error);
