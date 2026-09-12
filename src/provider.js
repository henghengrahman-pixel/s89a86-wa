function get(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((a, k) => a?.[k], obj);
}

function authHeaders({ json = true } = {}) {
  const apiKey = String(process.env.API_CO_ID_API_KEY || '').trim();
  if (!apiKey) throw new Error('API_CO_ID_API_KEY belum diisi.');
  const header = String(process.env.API_CO_ID_AUTH_HEADER || 'Authorization').trim();
  const prefix = process.env.API_CO_ID_AUTH_PREFIX ?? 'Bearer';
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    accept: 'application/json',
    [header]: prefix ? `${prefix} ${apiKey}` : apiKey
  };
}

function cleanBase(base) {
  return String(base || '').trim().replace(/\/+$/, '');
}
function cleanPath(path, fallback) {
  const p = String(path || fallback || '').trim();
  return p.startsWith('/') ? p : `/${p}`;
}
export function providerBaseUrl() {
  return cleanBase(process.env.API_CO_ID_API_BASE || 'https://chat.api.co.id');
}
export function resolveSendUrl() {
  const explicit = String(process.env.API_CO_ID_SEND_URL || '').trim();
  if (explicit) return explicit;
  return `${providerBaseUrl()}${cleanPath(process.env.API_CO_ID_SEND_PATH, '/api/v1/public/messages/send')}`;
}
function publicUrl(path) {
  return `${providerBaseUrl()}${cleanPath(path)}`;
}

function normalizeProviderError(response, rawText, data, url) {
  const contentType = String(response.headers.get('content-type') || '');
  const isHtml = contentType.includes('text/html') || /^\s*<!doctype html/i.test(rawText);
  if (isHtml) {
    return { code:'PROVIDER_HTML_RESPONSE', message:`Endpoint provider mengembalikan HTML (HTTP ${response.status}). Periksa API_CO_ID_API_BASE.`, status:response.status, url };
  }
  return {
    code:'PROVIDER_HTTP_ERROR',
    message:data?.message || data?.error || data?.detail || `Provider gagal: HTTP ${response.status}`,
    status:response.status, url, provider:data
  };
}

async function requestJson(url, { method='GET', body, timeoutMs, retry=true } = {}) {
  const maxTimeout = Number(timeoutMs || process.env.API_CO_ID_TIMEOUT_MS || 8000);
  const attempts = retry && method === 'GET' ? 2 : 1;
  let lastErr;
  for (let i=0;i<attempts;i++) {
    try {
      const response = await fetch(url, {
        method,
        headers:authHeaders({json:true}),
        ...(body !== undefined ? {body:JSON.stringify(body)} : {}),
        signal:AbortSignal.timeout(maxTimeout)
      });
      const rawText = await response.text();
      let data = null;
      try { data = rawText ? JSON.parse(rawText) : {}; } catch {}
      if (!response.ok || data?.success === false) {
        const normalized = normalizeProviderError(response, rawText, data, url);
        const err = new Error(normalized.message); err.providerResponse = normalized; throw err;
      }
      if (data === null) {
        const err = new Error('Provider mengembalikan respons non-JSON.');
        err.providerResponse={code:'PROVIDER_INVALID_RESPONSE',status:response.status,url}; throw err;
      }
      return data;
    } catch (e) {
      lastErr=e;
      const status=e?.providerResponse?.status;
      if (i+1>=attempts || (status && status<500 && status!==429)) break;
      await new Promise(r=>setTimeout(r,180*(i+1)));
    }
  }
  if (!lastErr?.providerResponse) {
    lastErr.providerResponse={code:'PROVIDER_NETWORK_ERROR',url};
    lastErr.message=`Tidak dapat terhubung ke API.CO.ID: ${lastErr.message}`;
  }
  throw lastErr;
}

function qs(params={}) {
  const s=new URLSearchParams();
  for (const [k,v] of Object.entries(params)) if (v!==undefined && v!==null && v!=='') s.set(k,String(v));
  const str=s.toString(); return str ? `?${str}` : '';
}
function dataArray(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.data?.data)) return res.data.data;
  if (Array.isArray(res?.data?.items)) return res.data.items;
  if (Array.isArray(res?.data?.conversations)) return res.data.conversations;
  if (Array.isArray(res?.data?.messages)) return res.data.messages;
  if (Array.isArray(res?.conversations)) return res.conversations;
  if (Array.isArray(res?.messages)) return res.messages;
  if (Array.isArray(res?.results)) return res.results;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}
function nextCursor(res) {
  return res?.next_cursor ?? res?.data?.next_cursor ?? res?.pagination?.next_cursor ?? res?.data?.pagination?.next_cursor ?? null;
}

export async function listPhoneNumbers() {
  const raw=await requestJson(publicUrl('/api/v1/public/phone-numbers'));
  return {items:dataArray(raw),raw};
}
export async function listConversations({limit=50,cursor=null,channel='whatsapp'}={}) {
  const raw=await requestJson(publicUrl(`/api/v1/public/conversations${qs({limit,cursor,channel})}`),{timeoutMs:5000});
  return {items:dataArray(raw),nextCursor:nextCursor(raw),raw};
}
export async function getConversationMessages(identifier,{limit=50,cursor=null,direction=null}={}) {
  const id=encodeURIComponent(String(identifier));
  const raw=await requestJson(publicUrl(`/api/v1/public/conversations/${id}/messages${qs({limit,cursor,direction})}`),{timeoutMs:6000});
  return {items:dataArray(raw),nextCursor:nextCursor(raw),raw};
}
export async function markMessageRead(messageId) {
  const id=encodeURIComponent(String(messageId));
  return requestJson(publicUrl(`/api/v1/public/messages/${id}/read`),{method:'POST',body:{},retry:false});
}
export async function sendTyping({identifier,channel='whatsapp'}={}) {
  const id=encodeURIComponent(String(identifier));
  const phoneId=String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  return requestJson(publicUrl(`/api/v1/public/conversations/${id}/typing`),{
    method:'POST', body:{channel,...(phoneId?{whatsapp_phone_number_id:phoneId}:{})}, retry:false, timeoutMs:4000
  });
}
export async function getWindowStatus(identifier) {
  const id=encodeURIComponent(String(identifier));
  return requestJson(publicUrl(`/api/v1/public/customers/${id}/window-status`),{timeoutMs:4000});
}
export async function listWebhooks() {
  const raw=await requestJson(publicUrl('/api/v1/public/webhooks'),{timeoutMs:4000});
  return {items:dataArray(raw),raw};
}

export async function uploadMedia({buffer,filename,mimeType}) {
  const url=publicUrl('/api/v1/public/media/upload');
  const form=new FormData();
  form.append('file',new Blob([buffer],{type:mimeType||'application/octet-stream'}),filename||'file');
  const phoneId=String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  if (phoneId) form.append('whatsapp_phone_number_id',phoneId);
  let response;
  try {
    response=await fetch(url,{method:'POST',headers:authHeaders({json:false}),body:form,signal:AbortSignal.timeout(Number(process.env.API_CO_ID_UPLOAD_TIMEOUT_MS||20000))});
  } catch(e) {
    const err=new Error(`Upload media ke API.CO.ID gagal: ${e.message}`); err.providerResponse={code:'PROVIDER_NETWORK_ERROR',url}; throw err;
  }
  const rawText=await response.text(); let data=null; try{data=rawText?JSON.parse(rawText):{};}catch{}
  if(!response.ok || data?.success===false){const n=normalizeProviderError(response,rawText,data,url);const e=new Error(n.message);e.providerResponse=n;throw e;}
  const mediaId=get(data,'data.media_id')||get(data,'data.id')||get(data,'media_id')||get(data,'id')||null;
  const mediaUrl=get(data,'data.media_url')||get(data,'data.url')||get(data,'media_url')||get(data,'url')||null;
  return {mediaId:mediaId?String(mediaId):null,mediaUrl:mediaUrl?String(mediaUrl):null,raw:data};
}

export async function sendMessage({to,messageType='text',content='',mediaUrl=null,replyToMessageId=null}) {
  const url=resolveSendUrl();
  const body={phone_number:String(to),channel:'whatsapp',message_type:messageType};
  if(content) body.content=content;
  if(mediaUrl) body.media_url=mediaUrl;
  if(replyToMessageId) body.reply_to_message_id=replyToMessageId;
  const phoneNumberId=String(process.env.WHATSAPP_PHONE_NUMBER_ID||'').trim();
  if(phoneNumberId) body.whatsapp_phone_number_id=phoneNumberId;
  const data=await requestJson(url,{method:'POST',body,retry:false,timeoutMs:15000});
  const idPath=String(process.env.API_CO_ID_MESSAGE_ID_PATH||'data.message_id').trim();
  const messageId=get(data,idPath)||get(data,'data.message_id')||get(data,'data.id')||get(data,'message_id')||get(data,'id')||null;
  return {messageId:messageId?String(messageId):null,raw:data,url};
}
export async function sendText({to,text,replyToMessageId=null}) {
  return sendMessage({to,messageType:'text',content:text,replyToMessageId});
}
