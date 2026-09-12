const socket=io();
const listEl=document.querySelector("#conversationList");
const searchEl=document.querySelector("#search");
const empty=document.querySelector("#emptyState");
const chatView=document.querySelector("#chatView");
const chatPane=document.querySelector(".chat-pane");
const msgEl=document.querySelector("#messages");
const nameEl=document.querySelector("#chatName");
const phoneEl=document.querySelector("#chatPhone");
const composer=document.querySelector("#composer");
const input=document.querySelector("#messageInput");
const sendBtn=document.querySelector("#sendBtn");
const sendError=document.querySelector("#sendError");
const toggleStatus=document.querySelector("#toggleStatus");

let conversations=[];
let current=null;

const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=t=>t?new Date(t).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}):"";
const initial=s=>(String(s||"?").trim()[0]||"?").toUpperCase();

async function api(url,opt={}){
  const r=await fetch(url,{headers:{"content-type":"application/json",...(opt.headers||{})},...opt});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw Object.assign(new Error(data.error||`HTTP ${r.status}`),{data});
  return data;
}
async function loadConversations(){
  const d=await api("/api/conversations");
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
  listEl.innerHTML=rows.map(c=>`
    <div class="conv ${current?.id===c.id?"active":""}" data-id="${c.id}">
      <div class="conv-avatar">${esc(initial(c.display_name||c.phone))}</div>
      <div class="conv-main">
        <div class="conv-top"><div class="conv-name">${esc(c.display_name||c.profile_name||c.phone)}</div><div class="conv-time">${fmt(c.last_message_at)}</div></div>
        <div class="conv-bottom"><div class="conv-preview">${esc(c.last_message_preview||"Belum ada pesan")}</div>${c.unread_count?`<span class="unread">${c.unread_count}</span>`:""}</div>
      </div>
    </div>`).join("");
}
listEl.addEventListener("click",e=>{
  const row=e.target.closest(".conv"); if(row) openConversation(row.dataset.id);
});
searchEl.addEventListener("input",renderList);

async function openConversation(id){
  const d=await api(`/api/conversations/${id}/messages`);
  current=d.conversation;
  empty.classList.add("hidden");chatView.classList.remove("hidden");chatPane.classList.add("mobile-open");
  nameEl.textContent=current.display_name||current.profile_name||current.phone;
  phoneEl.textContent=current.phone;
  toggleStatus.textContent=current.status==="closed"?"Buka chat":"Tutup chat";
  renderMessages(d.messages);
  await api(`/api/conversations/${id}/read`,{method:"POST",body:"{}"}).catch(()=>{});
  loadConversations();
}
function renderMessages(messages){
  msgEl.innerHTML=messages.map(m=>`
    <div class="bubble ${m.direction}">
      <div>${esc(m.body||`[${m.message_type}]`)}</div>
      <div class="bubble-meta">${fmt(m.created_at)} ${m.direction==="out"?`<span class="status">${esc(m.status||"sent")}</span>`:""}</div>
    </div>`).join("");
  msgEl.scrollTop=msgEl.scrollHeight;
}
composer.addEventListener("submit",async e=>{
  e.preventDefault(); if(!current)return;
  const body=input.value.trim(); if(!body)return;
  sendBtn.disabled=true; sendError.classList.add("hidden");
  try{
    await api(`/api/conversations/${current.id}/messages`,{method:"POST",body:JSON.stringify({body})});
    input.value="";
    await openConversation(current.id);
  }catch(err){
    sendError.textContent=err.message+(err.data?.provider?` — ${JSON.stringify(err.data.provider)}`:"");
    sendError.classList.remove("hidden");
  }finally{sendBtn.disabled=false;input.focus()}
});
toggleStatus.addEventListener("click",async()=>{
  if(!current)return;
  const status=current.status==="closed"?"open":"closed";
  await api(`/api/conversations/${current.id}/status`,{method:"POST",body:JSON.stringify({status})});
  current.status=status;toggleStatus.textContent=status==="closed"?"Buka chat":"Tutup chat";loadConversations();
});

socket.on("message:new",m=>{
  loadConversations();
  if(current?.id===m.conversation_id) openConversation(current.id);
});
socket.on("message:update",m=>{if(current?.id===m.conversation_id)openConversation(current.id)});
socket.on("conversation:refresh",()=>loadConversations());
socket.on("conversation:update",()=>loadConversations());

loadConversations().catch(console.error);
