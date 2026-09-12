function get(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

function first(...vals) {
  return vals.find(v => v !== undefined && v !== null && v !== "");
}

export function normalizeWebhook(payload) {
  const events = [];

  // Meta Cloud API style
  const entries = payload?.entry;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        const contacts = value.contacts || [];
        for (const m of value.messages || []) {
          const c = contacts.find(x => x?.wa_id === m?.from) || contacts[0] || {};
          const type = m?.type || "text";
          let body = "";
          let mediaUrl = null;
          if (type === "text") body = m?.text?.body || "";
          else if (type === "button") body = m?.button?.text || "";
          else if (type === "interactive") body = m?.interactive?.button_reply?.title || m?.interactive?.list_reply?.title || "";
          else {
            body = m?.caption || m?.[type]?.caption || "";
            mediaUrl = m?.[type]?.link || m?.[type]?.url || null;
          }
          events.push({
            kind: "message",
            providerMessageId: m?.id,
            waId: m?.from,
            phone: m?.from,
            displayName: c?.profile?.name || c?.name || m?.from,
            profileName: c?.profile?.name || null,
            type, body, mediaUrl, raw: m
          });
        }
        for (const s of value.statuses || []) {
          events.push({
            kind: "status",
            providerMessageId: s?.id,
            status: s?.status,
            raw: s
          });
        }
      }
    }
  }

  // Generic API.CO.ID / CRM wrappers
  const candidates = [
    payload?.message,
    payload?.data?.message,
    payload?.data,
    payload
  ].filter(Boolean);

  if (!events.some(e => e.kind === "message")) {
    for (const m of candidates) {
      const from = first(m?.from, m?.sender, m?.phone, m?.wa_id, m?.contact?.wa_id, m?.contact?.phone);
      const text = first(m?.text?.body, m?.text, m?.body, m?.message, m?.content?.text, "");
      const type = first(m?.type, m?.message_type, "text");
      const id = first(m?.id, m?.message_id, m?.messageId, payload?.id);
      if (from && (text || type !== "text")) {
        events.push({
          kind: "message",
          providerMessageId: id ? String(id) : null,
          waId: String(from).replace(/[^\d+]/g, ""),
          phone: String(from).replace(/[^\d+]/g, ""),
          displayName: first(m?.name, m?.profile_name, m?.contact?.name, from),
          profileName: first(m?.profile_name, m?.contact?.name, null),
          type: String(type),
          body: typeof text === "string" ? text : JSON.stringify(text),
          mediaUrl: first(m?.media_url, m?.url, m?.media?.url, null),
          raw: m
        });
        break;
      }
    }
  }

  if (!events.some(e => e.kind === "status")) {
    const s = payload?.status || payload?.data?.status;
    const mid = first(payload?.message_id, payload?.messageId, payload?.data?.message_id, payload?.data?.messageId);
    if (s && mid) {
      events.push({ kind: "status", providerMessageId: String(mid), status: String(s), raw: payload });
    }
  }

  return events;
}
