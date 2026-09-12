function renderTemplate(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
  }
  if (Array.isArray(value)) return value.map(v => renderTemplate(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderTemplate(v, vars);
    return out;
  }
  return value;
}

function get(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((a, k) => a?.[k], obj);
}

export async function sendText({ to, text }) {
  const url = process.env.API_CO_ID_SEND_URL;
  const apiKey = process.env.API_CO_ID_API_KEY;
  if (!url) throw new Error("API_CO_ID_SEND_URL belum diisi.");
  if (!apiKey) throw new Error("API_CO_ID_API_KEY belum diisi.");

  let bodyTemplate;
  try {
    bodyTemplate = JSON.parse(process.env.API_CO_ID_SEND_BODY || '{"to":"{{to}}","type":"text","text":{"body":"{{text}}"}}');
  } catch {
    throw new Error("API_CO_ID_SEND_BODY bukan JSON yang valid.");
  }

  const vars = {
    to,
    text,
    phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    waba_id: process.env.WHATSAPP_WABA_ID || ""
  };
  const body = renderTemplate(bodyTemplate, vars);

  const header = process.env.API_CO_ID_AUTH_HEADER || "Authorization";
  const prefix = process.env.API_CO_ID_AUTH_PREFIX ?? "Bearer";
  const authValue = prefix ? `${prefix} ${apiKey}` : apiKey;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [header]: authValue
    },
    body: JSON.stringify(body)
  });

  const textResp = await response.text();
  let data;
  try { data = JSON.parse(textResp); } catch { data = { raw: textResp }; }

  if (!response.ok) {
    const err = new Error(`Provider send gagal: HTTP ${response.status}`);
    err.providerResponse = data;
    throw err;
  }

  const idPath = process.env.API_CO_ID_MESSAGE_ID_PATH || "id";
  const messageId =
    get(data, idPath) ||
    get(data, "messages.0.id") ||
    get(data, "data.id") ||
    get(data, "data.message_id") ||
    get(data, "message_id") ||
    null;

  return { messageId: messageId ? String(messageId) : null, raw: data };
}
