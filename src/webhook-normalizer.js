function first(...vals) {
  return vals.find(v => v !== undefined && v !== null && v !== "");
}
function digits(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.replace(/[^\d+]/g, "") : null;
}

export function normalizeWebhook(payload) {
  const events = [];

  // === API.CO.ID exact webhook shape ===
  // payload.event_type = message.received / message.sent / message.delivered / message.read / message.failed
  // payload.data = { direction, content, message_id, customer_phone, message_type, ... }
  const eventType = String(payload?.event_type || "").toLowerCase();
  const d = payload?.data || null;

  if (d && eventType.startsWith("message.")) {
    const phone = digits(first(d.customer_phone, d.raw?.from));
    const providerMessageId = first(d.message_id, d.raw?.id);
    const providerReplyId = first(d.raw?.id, d.message_id);
    const messageType = first(d.message_type, d.raw?.type, "text");
    const content = first(d.content, d.raw?.text?.body, "");
    const when = first(payload?.timestamp, d.raw?.timestamp ? new Date(Number(d.raw.timestamp) * 1000).toISOString() : null);

    if (eventType === "message.received" && phone) {
      events.push({
        kind: "message",
        direction: "in",
        providerMessageId: providerMessageId ? String(providerMessageId) : null,
        providerReplyId: providerReplyId ? String(providerReplyId) : null,
        waId: phone,
        phone,
        customerId: d.customer_id || null,
        phoneNumberId: d.phone_number_id || null,
        businessPhone: d.business_phone || null,
        displayName: first(
          d.customer_name,
          d.customer?.name,
          d.contact?.name,
          d.raw?.contacts?.[0]?.profile?.name,
          phone
        ),
        profileName: first(
          d.customer_name,
          d.customer?.name,
          d.contact?.name,
          d.raw?.contacts?.[0]?.profile?.name,
          null
        ),
        type: String(messageType),
        body: typeof content === "string"
          ? (content || (String(messageType)==='text' ? '' : `[${String(messageType)}]`))
          : JSON.stringify(content),
        mediaUrl: first(
          d.media_url, d.media?.url,
          d.raw?.image?.url, d.raw?.image?.link,
          d.raw?.document?.url, d.raw?.document?.link,
          d.raw?.video?.url, d.raw?.video?.link,
          d.raw?.audio?.url, d.raw?.audio?.link,
          null
        ),
        replyToProviderMessageId: first(
          d.reply_to_message_id,
          d.raw?.context?.id,
          d.raw?.reply_to_message_id,
          null
        ),
        createdAt: when || null,
        raw: payload
      });
      return events;
    }

    if (eventType === "message.sent" && phone) {
      events.push({
        kind: "outbound_message",
        direction: "out",
        providerMessageId: providerMessageId ? String(providerMessageId) : null,
        providerReplyId: providerReplyId ? String(providerReplyId) : null,
        waId: phone,
        phone,
        customerId: d.customer_id || null,
        phoneNumberId: d.phone_number_id || null,
        businessPhone: d.business_phone || null,
        displayName: first(d.customer_name,d.customer?.name,d.contact?.name,phone),
        profileName: first(d.customer_name,d.customer?.name,d.contact?.name,null),
        type: String(messageType),
        body: typeof content === "string" ? content : JSON.stringify(content),
        mediaUrl: first(d.media_url, d.media?.url, null),
        replyToProviderMessageId: first(d.reply_to_message_id, d.raw?.context?.id, null),
        createdAt: when || null,
        status: "sent",
        raw: payload
      });
      return events;
    }

    if (["message.delivered","message.read","message.failed"].includes(eventType)) {
      events.push({
        kind: "status",
        providerMessageId: providerMessageId ? String(providerMessageId) : null,
        status: eventType.split(".")[1],
        raw: payload
      });
      return events;
    }
  }

  // === Meta Cloud API native fallback ===
  if (Array.isArray(payload?.entry)) {
    for (const entry of payload.entry) {
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
          else if (type === "interactive") {
            body = m?.interactive?.button_reply?.title || m?.interactive?.list_reply?.title || "";
          } else {
            body = m?.caption || m?.[type]?.caption || "";
            mediaUrl = m?.[type]?.link || m?.[type]?.url || null;
          }

          const phone = digits(m?.from);
          if (phone) {
            events.push({
              kind: "message",
              direction: "in",
              providerMessageId: m?.id || null,
              providerReplyId: m?.id || null,
              waId: phone,
              phone,
              displayName: c?.profile?.name || c?.name || phone,
              profileName: c?.profile?.name || null,
              type,
              body,
              mediaUrl,
              replyToProviderMessageId: m?.context?.id || null,
              createdAt: m?.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
              raw: payload
            });
          }
        }

        for (const s of value.statuses || []) {
          events.push({
            kind: "status",
            providerMessageId: s?.id || null,
            status: s?.status || null,
            raw: payload
          });
        }
      }
    }
  }

  return events;
}
