function first(...vals) {
  return vals.find(v => v !== undefined && v !== null && v !== "");
}
function digits(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.replace(/[^\d+]/g, "") : null;
}
function isObj(v){ return v && typeof v === "object" && !Array.isArray(v); }

function deepObjects(root, max=500) {
  const out=[], q=[root], seen=new Set();
  while(q.length && out.length<max){
    const v=q.shift();
    if(!v || typeof v!=="object" || seen.has(v)) continue;
    seen.add(v);
    if(isObj(v)) out.push(v);
    if(Array.isArray(v)) q.push(...v);
    else q.push(...Object.values(v));
  }
  return out;
}

function genericMessage(payload) {
  const objs=deepObjects(payload);
  for(const m of objs){
    const from = first(
      m.from, m.sender, m.sender_id, m.senderId, m.phone, m.phone_number,
      m.wa_id, m.waId, m.contact?.wa_id, m.contact?.waId, m.contact?.phone,
      m.customer?.phone, m.customer?.wa_id
    );
    const text = first(
      m.text?.body,
      typeof m.text==="string" ? m.text : undefined,
      m.body, m.message, m.message_text, m.content?.text,
      m.content?.body, m.payload?.text
    );
    const type = first(m.type, m.message_type, m.messageType, "text");
    const id = first(m.id, m.message_id, m.messageId, m.mid);
    const direction = String(first(m.direction, m.message_direction, "")).toLowerCase();

    // Hindari status-only object dan outbound/sent event dianggap inbound.
    if (direction && ["out","outbound","sent","outgoing"].includes(direction)) continue;
    if (from && (text !== undefined || String(type).toLowerCase() !== "text")) {
      const phone=digits(from);
      if (!phone) continue;
      return {
        kind:"message",
        providerMessageId:id ? String(id) : null,
        waId:phone,
        phone,
        displayName:first(
          m.name, m.profile_name, m.profileName, m.contact?.name,
          m.customer?.name, phone
        ),
        profileName:first(m.profile_name,m.profileName,m.contact?.name,m.customer?.name,null),
        type:String(type),
        body: typeof text==="string" ? text : (text == null ? "" : JSON.stringify(text)),
        mediaUrl:first(m.media_url,m.mediaUrl,m.url,m.media?.url,m.image?.url,null),
        raw:m
      };
    }
  }
  return null;
}

export function normalizeWebhook(payload) {
  const events=[];

  // Meta Cloud API native shape
  if (Array.isArray(payload?.entry)) {
    for (const entry of payload.entry) {
      for (const change of entry?.changes || []) {
        const value=change?.value || {};
        const contacts=value.contacts || [];
        for (const m of value.messages || []) {
          const c=contacts.find(x=>x?.wa_id===m?.from) || contacts[0] || {};
          const type=m?.type || "text";
          let body="", mediaUrl=null;
          if(type==="text") body=m?.text?.body || "";
          else if(type==="button") body=m?.button?.text || "";
          else if(type==="interactive") body=m?.interactive?.button_reply?.title || m?.interactive?.list_reply?.title || "";
          else {
            body=m?.caption || m?.[type]?.caption || "";
            mediaUrl=m?.[type]?.link || m?.[type]?.url || null;
          }
          events.push({
            kind:"message", providerMessageId:m?.id,
            waId:digits(m?.from), phone:digits(m?.from),
            displayName:c?.profile?.name || c?.name || m?.from,
            profileName:c?.profile?.name || null,
            type, body, mediaUrl, raw:m
          });
        }
        for(const s of value.statuses || []){
          events.push({kind:"status",providerMessageId:s?.id,status:s?.status,raw:s});
        }
      }
    }
  }

  // API.CO.ID/common event wrappers
  const eventName=String(first(payload?.event,payload?.type,payload?.event_type,payload?.data?.event,"")).toLowerCase();
  const statusCandidate=first(
    payload?.status, payload?.data?.status, payload?.message?.status,
    payload?.data?.message?.status
  );
  const statusMid=first(
    payload?.message_id,payload?.messageId,payload?.data?.message_id,
    payload?.data?.messageId,payload?.message?.id,payload?.data?.message?.id
  );

  if (!events.some(e=>e.kind==="status") && statusCandidate && statusMid &&
      /(sent|delivered|read|failed|status)/.test(eventName+" "+statusCandidate)) {
    events.push({kind:"status",providerMessageId:String(statusMid),status:String(statusCandidate),raw:payload});
  }

  if (!events.some(e=>e.kind==="message")) {
    const g=genericMessage(payload);
    if(g) events.push(g);
  }

  return events;
}
