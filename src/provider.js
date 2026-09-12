function get(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((a, k) => a?.[k], obj);
}

function authHeaders() {
  const apiKey = String(process.env.API_CO_ID_API_KEY || "").trim();
  if (!apiKey) throw new Error("API_CO_ID_API_KEY belum diisi.");

  const header = String(process.env.API_CO_ID_AUTH_HEADER || "Authorization").trim();
  const prefix = process.env.API_CO_ID_AUTH_PREFIX ?? "Bearer";

  return {
    "content-type": "application/json",
    "accept": "application/json",
    [header]: prefix ? `${prefix} ${apiKey}` : apiKey
  };
}

function cleanBase(base) {
  return String(base || "").trim().replace(/\/+$/, "");
}

function cleanPath(path) {
  const p = String(path || "").trim();
  if (!p) return "/api/v1/public/messages/send";
  return p.startsWith("/") ? p : `/${p}`;
}

export function resolveSendUrl() {
  const explicit = String(process.env.API_CO_ID_SEND_URL || "").trim();
  if (explicit) return explicit;

  const base = cleanBase(process.env.API_CO_ID_API_BASE || "https://chat.api.co.id");
  const path = cleanPath(process.env.API_CO_ID_SEND_PATH || "/api/v1/public/messages/send");
  return `${base}${path}`;
}

function normalizeProviderError(response, rawText, data, url) {
  const contentType = String(response.headers.get("content-type") || "");
  const isHtml = contentType.includes("text/html") || /^\s*<!doctype html/i.test(rawText);

  if (isHtml) {
    return {
      code: "PROVIDER_HTML_RESPONSE",
      message: `Endpoint provider mengembalikan HTML (HTTP ${response.status}). Periksa API_CO_ID_API_BASE / API_CO_ID_SEND_URL.`,
      status: response.status,
      url
    };
  }

  return {
    code: "PROVIDER_HTTP_ERROR",
    message:
      data?.message ||
      data?.error ||
      data?.detail ||
      `Provider send gagal: HTTP ${response.status}`,
    status: response.status,
    url,
    provider: data
  };
}

export async function sendMessage({
  to,
  messageType = "text",
  content = "",
  mediaUrl = null,
  replyToMessageId = null
}) {
  const url = resolveSendUrl();

  const body = {
    phone_number: String(to),
    channel: "whatsapp",
    message_type: messageType
  };

  if (content) body.content = content;
  if (mediaUrl) body.media_url = mediaUrl;
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;

  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  if (phoneNumberId) body.whatsapp_phone_number_id = phoneNumberId;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    const err = new Error(`Tidak dapat terhubung ke endpoint API.CO.ID: ${e.message}`);
    err.providerResponse = {
      code: "PROVIDER_NETWORK_ERROR",
      url
    };
    throw err;
  }

  const rawText = await response.text();
  let data;
  try { data = JSON.parse(rawText); }
  catch { data = null; }

  if (!response.ok) {
    const normalized = normalizeProviderError(response, rawText, data, url);
    const err = new Error(normalized.message);
    err.providerResponse = normalized;
    throw err;
  }

  if (!data) {
    const err = new Error("Provider mengembalikan respons non-JSON.");
    err.providerResponse = {
      code: "PROVIDER_INVALID_RESPONSE",
      status: response.status,
      url
    };
    throw err;
  }

  if (data?.success === false) {
    const err = new Error(data?.message || data?.error || "Provider menolak pengiriman pesan.");
    err.providerResponse = {
      code: "PROVIDER_REJECTED",
      status: response.status,
      url,
      provider: data
    };
    throw err;
  }

  const idPath = String(process.env.API_CO_ID_MESSAGE_ID_PATH || "message_id").trim();
  const messageId =
    get(data, idPath) ||
    get(data, "data.message_id") ||
    get(data, "data.id") ||
    get(data, "message_id") ||
    get(data, "id") ||
    null;

  return {
    messageId: messageId ? String(messageId) : null,
    raw: data,
    url
  };
}

export async function sendText({ to, text, replyToMessageId = null }) {
  return sendMessage({
    to,
    messageType: "text",
    content: text,
    replyToMessageId
  });
}
