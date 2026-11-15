// QQ Bridge boundary adapter.
//
// DSH records tool orchestration, while QQ Bridge records the conversation
// that actually reached a person. This module is deliberately pure: it only
// normalises already recorded events and never calls QQ or serialises a whole
// tool payload into a memory.

const INBOUND_TOOLS = new Set(["qq_get_prompt", "qq_get_unread_messages", "qq_wait_for_messages"]);
const OUTBOUND_TOOLS = new Set([
  "qq_send_message",
  "qq_send_group_message",
  "qq_send_private_message",
  "qq_reply",
  "qq_send_burst"
]);

function parseJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.raw_message === "string") return value.raw_message;
  if (typeof value.message === "string") return value.message;
  if (value.content !== undefined) return textOf(value.content);
  return "";
}

function toolName(value) {
  const raw = typeof value === "string" ? value : value?.name ?? value?.toolName ?? value?.tool_name;
  if (typeof raw !== "string") return "";
  return raw.split("__").at(-1).trim();
}

function eventSeq(event) {
  return Number.isSafeInteger(event?.seq) ? event.seq : undefined;
}

function idOf(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["message_id", "messageId", "msg_id", "msgId", "id", "messageKey", "message_key"]) {
    if (typeof value[key] === "string" || typeof value[key] === "number") return String(value[key]);
  }
  return "";
}

function senderOf(value) {
  if (!value || typeof value !== "object") return {};
  const sender = value.sender && typeof value.sender === "object" ? value.sender : {};
  const senderName = typeof value.sender === "string"
    ? value.sender
    : sender.nickname ?? sender.name ?? value.nickname ?? value.sender_name ?? undefined;
  const explicitChannel = value.channel ?? value.chat_type ?? value.chatType;
  const groupId = value.group_id ?? value.groupId ?? value.guild_id ?? value.guildId;
  return {
    senderId: String(sender.user_id ?? sender.userId ?? value.user_id ?? value.userId ?? "") || undefined,
    senderName,
    groupId: String(groupId ?? "") || undefined,
    ...(explicitChannel !== undefined || groupId !== undefined
      ? { channel: explicitChannel ?? "group" }
      : {})
  };
}

function conversationOf(value) {
  if (!value || typeof value !== "object") return undefined;
  return value.conversation_id ?? value.conversationId ?? value.session_key ?? value.sessionKey
    ?? value.target_id ?? value.targetId ?? value.key;
}

function eventMetadata(value, inherited = {}) {
  const metadata = { ...inherited, ...senderOf(value) };
  const conversation = conversationOf(value);
  if (conversation !== undefined) {
    metadata.conversationId = String(conversation);
    const key = String(conversation).toLowerCase();
    if (key.startsWith("group:")) metadata.channel = "group";
    else if (key.startsWith("private:")) metadata.channel = "private";
  }
  const qqSeq = value?.seq ?? value?.messageSeq ?? value?.sequence;
  if (Number.isSafeInteger(qqSeq) || (typeof qqSeq === "string" && /^-?\d+$/.test(qqSeq))) {
    metadata.qqSeq = Number(qqSeq);
  }
  return metadata;
}

function isSelfMessage(value) {
  return value?.isSelf === true || value?.is_self === true;
}

function looksLikeMessage(value) {
  if (!value || typeof value !== "object" || value.type === "text" || value.role === "tool") return false;
  const text = textOf(value).trim();
  return Boolean(text && (
    value.text !== undefined || value.raw_message !== undefined || value.message !== undefined ||
    value.content !== undefined || value.post_type === "message" || value.message_type !== undefined
  ));
}

function walkMessages(value, out, meta = {}, depth = 0) {
  if (depth > 8 || value == null) return;
  const parsed = parseJson(value);
  if (parsed !== value) return walkMessages(parsed, out, meta, depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) walkMessages(item, out, meta, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  // Tool result content commonly wraps the JSON payload in a text block. It
  // is transport syntax, never a QQ message in its own right.
  if (value.type === "text") {
    const parsedText = parseJson(value.text);
    if (parsedText !== value.text) walkMessages(parsedText, out, meta, depth + 1);
    return;
  }
  const nestedMeta = eventMetadata(value, meta);
  if (isSelfMessage(value)) return;
  if (looksLikeMessage(value) && !value.error && value.timeout !== true && value.waiting !== true) {
    out.push({ text: textOf(value).trim(), messageId: idOf(value) || undefined, metadata: nestedMeta });
    return;
  }
  for (const key of ["messages", "newMessages", "unreadMessages", "data", "result", "payload", "items", "records"]) {
    if (value[key] !== undefined) walkMessages(value[key], out, nestedMeta, depth + 1);
  }
}

function toolPayload(data) {
  const message = data?.message;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const textBlock = blocks.find((block) => block?.type === "text" && typeof block.text === "string");
  const result = data?.result ?? data?.output ?? data?.content ?? textBlock?.text ?? message?.result ?? message;
  return parseJson(result);
}

function toolCallId(data) {
  const value = data?.callId ?? data?.call_id ?? data?.toolCallId ?? data?.tool_call_id
    ?? data?.message?.callId ?? data?.message?.toolCallId ?? data?.message?.source?.callId;
  return value == null ? "" : String(value);
}

function callArgs(data) {
  return parseJson(data?.arguments ?? data?.args ?? data?.input ?? data?.message?.arguments ?? {});
}

function isQqToolCall(data) {
  return toolName(data?.name ?? data?.toolName ?? data?.message?.source?.toolName
    ?? data?.message?.source?.name ?? data?.message?.name);
}

function messageTexts(args) {
  const raw = args?.messages ?? args?.message ?? args?.text ?? args?.content;
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) return parsed.map(textOf).map((text) => text.trim()).filter(Boolean);
  const text = textOf(parsed).trim();
  return text ? [text] : [];
}

function sentCount(payload, requested) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const count = Number(payload.sent);
    if (Number.isFinite(count)) return Math.max(0, Math.min(requested, Math.floor(count)));
  }
  if (payload === true && requested === 1) return 1;
  if (Array.isArray(payload)) return payload.filter((item) => item?.sent === true || item?.status === "sent").length;
  return null;
}

function extractWakeSnapshot(text) {
  const marker = "【本次消息快照】";
  const start = String(text ?? "").indexOf(marker);
  if (start < 0) return null;
  const body = String(text).slice(start + marker.length).replace(/^\s*/, "");
  const end = body.indexOf("\n以上消息");
  const candidate = (end >= 0 ? body.slice(0, end) : body).trim();
  const packet = parseJson(candidate);
  return packet && typeof packet === "object" && (Array.isArray(packet.messages) || Array.isArray(packet.recent)) ? packet : null;
}

export function isQqBridgeTool(name) {
  const normalized = toolName(name);
  return INBOUND_TOOLS.has(normalized) || OUTBOUND_TOOLS.has(normalized);
}

export function isQqBridgeSession(session, events = []) {
  const header = session?.header ?? {};
  const preset = String(header.agentPreset ?? "").toLowerCase();
  const cwd = String(header.cwd ?? "").toLowerCase();
  if (preset.includes("qq") || cwd.includes("qq-bridge") || cwd.includes("qq_bridge")) return true;
  return events.some((event) => isQqBridgeTool(event?.data?.name ?? event?.data?.toolName
    ?? event?.data?.message?.source?.toolName ?? event?.data?.message?.source?.name));
}

/**
 * Normalise a session's DSH events into messages that really occurred in QQ.
 * `confirmation` is `sent` only for a successful send result. Prepared or
 * failed sends are omitted so a retry cannot become a false conversation.
 */
export function normalizeQqEvents(events, { sessionId = "" } = {}) {
  const ordered = Array.isArray(events) ? [...events].sort((a, b) => (eventSeq(a) ?? 0) - (eventSeq(b) ?? 0)) : [];
  const calls = new Map();
  const out = [];
  const seen = new Set();
  const sessionMetadata = {
    sessionId: sessionId || undefined,
    sourceSession: sessionId || undefined,
    ...(String(sessionId).toLowerCase().startsWith("qqb-g-") ? { channel: "group" } : {}),
    ...(String(sessionId).toLowerCase().startsWith("qqb-p-") ? { channel: "private" } : {})
  };
  const add = (part) => {
    const text = String(part?.text ?? "").trim();
    if (!text) return;
    const conversationKey = part.metadata?.conversationId ?? part.metadata?.channel ?? "";
    const explicit = part.messageId
      ? `msg:${conversationKey}:${part.messageId}`
      : part.metadata?.qqSeq !== undefined
        ? `qqseq:${conversationKey}:${part.metadata.qqSeq}:${part.kind}`
        : `event:${part.seq ?? "na"}:${part.kind}:${part.callId ?? ""}:${text}`;
    if (seen.has(explicit)) return;
    seen.add(explicit);
    out.push({
      role: part.kind === "outbound" ? "assistant" : "user",
      kind: part.kind,
      text,
      seq: part.seq,
      key: explicit,
      blocks: [{ type: "text", text }],
      metadata: {
        ...sessionMetadata,
        confirmation: part.confirmation,
        callId: part.callId || undefined,
        ...part.metadata
      }
    });
  };

  for (const event of ordered) {
    const seq = eventSeq(event);
    const data = event?.data ?? {};
    if (event?.type === "user/message" && (data?.source?.kind === undefined || data?.source?.kind === "user")) {
      const rawText = textOf(data.content);
      const packet = extractWakeSnapshot(rawText);
      if (packet) {
        const packetMetadata = eventMetadata(packet);
        for (const message of [...(packet.messages ?? []), ...(packet.recent ?? [])]) {
          if (isSelfMessage(message)) continue;
          add({ kind: "inbound", text: textOf(message), seq, messageId: idOf(message), metadata: { ...sessionMetadata, ...eventMetadata(message, packetMetadata), dshEventSeq: seq }, confirmation: "received" });
        }
      } else if (!rawText.includes("【会话令牌】")) {
        add({ kind: "inbound", text: rawText, seq, messageId: idOf(data), metadata: { ...sessionMetadata, ...eventMetadata(data), dshEventSeq: seq }, confirmation: "received" });
      }
      continue;
    }
    if (event?.type === "tool/call") {
      const name = isQqToolCall(data);
      if (isQqBridgeTool(name)) calls.set(toolCallId(data) || `seq:${seq}`, { name, args: callArgs(data), seq });
      continue;
    }
    if (event?.type !== "tool/result") continue;
    const callId = toolCallId(data);
    const call = calls.get(callId) ?? calls.get(`seq:${seq}`);
    const name = isQqToolCall(data) || call?.name;
    const result = toolPayload(data);
    if (INBOUND_TOOLS.has(name)) {
      const messages = [];
      walkMessages(result, messages);
      for (const message of messages) add({ kind: "inbound", text: message.text, seq, messageId: message.messageId, metadata: { ...sessionMetadata, ...message.metadata, dshEventSeq: seq }, confirmation: "received" });
      continue;
    }
    if (!OUTBOUND_TOOLS.has(name)) continue;
    const requested = messageTexts(call?.args ?? {});
    const confirmed = sentCount(result, requested.length);
    // A bare `{ok:true}` only acknowledges the tool call; it does not prove
    // how many messages reached QQ. Require an explicit sent count or actual
    // per-message sent records before adding assistant speech.
    // A tool error can still report a positive sent count when a burst was
    // only partially delivered. Preserve that confirmed prefix; discard a
    // failure with no confirmed sends.
    if (confirmed === null || confirmed === 0) continue;
    const messages = [];
    walkMessages(result, messages);
    // The result envelope often contains status prose (`message: "sent"`).
    // When call arguments are available, they are the authoritative text that
    // the tool attempted to send; use only the confirmed prefix. Fall back to
    // returned message records only when they carry message identity/sequence
    // metadata and no requested text is available.
    const explicitRecords = messages.filter((message) => message.messageId || message.metadata?.qqSeq !== undefined);
    const texts = requested.length
      ? requested.slice(0, confirmed)
      : explicitRecords.map((message) => message.text);
    for (const text of texts.slice(0, confirmed ?? texts.length)) add({ kind: "outbound", text, seq, callId, metadata: {}, confirmation: "sent" });
  }
  return out;
}

export const qqBridgeToolNames = Object.freeze({
  inbound: Object.freeze([...INBOUND_TOOLS]),
  outbound: Object.freeze([...OUTBOUND_TOOLS])
});
