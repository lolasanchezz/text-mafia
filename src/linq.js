// Linq V3 API client. See CLAUDE.md §3 for the verified endpoint reference.
// Every response shape is treated as suspect per CLAUDE.md §2 rule 4: unwrap
// both `{ data: ... }` and bare responses, extract ids with fallback chains,
// and log the raw body on any failure.

const BASE_URL = "https://api.linqapp.com/api/partner/v3";

function apiKey() {
  const key = process.env.LINQ_API_KEY;
  if (!key) throw new Error("LINQ_API_KEY is not set");
  return key;
}

function fromNumber() {
  const from = process.env.LINQ_FROM;
  if (!from) throw new Error("LINQ_FROM is not set");
  return from;
}

export function normalizePhone(raw) {
  if (!raw) throw new Error("empty phone number");
  const trimmed = String(raw).trim();
  if (/^\+\d{8,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw new Error(`cannot normalize phone number to E.164: "${raw}"`);
}

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await res.text();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    console.error(
      `[linq] ${method} ${path} -> ${res.status}\n${rawText}`,
    );
    const err = new Error(
      `Linq API error ${res.status} on ${method} ${path}`,
    );
    err.status = res.status;
    err.body = parsed ?? rawText;
    throw err;
  }

  // TODO: verify — confirm whether V3 responses are bare or `{ data: ... }`
  // wrapped once we see a real payload, then simplify this.
  const data = parsed?.data ?? parsed ?? {};
  return { data, raw: parsed, rawText };
}

// One recipient in `to` -> DM. Two or more -> group chat. Max 31 handles.
// The first outbound message must not contain a URL or link part (CLAUDE.md
// §3 hard constraint 1).
export async function createChat({ to, message, from }) {
  const recipients = (Array.isArray(to) ? to : [to]).map(normalizePhone);
  const { data, raw } = await request("/chats", {
    method: "POST",
    body: {
      from: from ?? fromNumber(),
      to: recipients,
      message: { parts: [{ type: "text", value: message }] },
    },
  });

  // Confirmed via smoke test 2026-09-19: POST /chats returns a bare
  // `{ chat: { id, is_group, message: { id, ... }, handles, ... } }` — not
  // `{ data: ... }` wrapped, and nested under `chat` unlike /messages
  // responses. Kept the older fallbacks in case this shifts across accounts.
  const chatId =
    data.chat?.id ?? data.chat_id ?? data.chatId ?? data.id ?? null;
  const messageId =
    data.chat?.message?.id ??
    data.message_id ??
    data.messageId ??
    data.message?.id ??
    data.id ??
    null;

  if (!chatId) {
    console.error("[linq] createChat: could not extract chat id from", raw);
  }

  return { chatId, messageId, raw };
}

export async function sendMessage(chatId, message, { replyTo } = {}) {
  const { data, raw } = await request(`/chats/${chatId}/messages`, {
    method: "POST",
    body: {
      message: { parts: [{ type: "text", value: message }] },
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
  });
  const messageId =
    data.message_id ?? data.messageId ?? data.id ?? data.message?.id ?? null;
  return { messageId, raw };
}

export async function listMessages(chatId) {
  const { data } = await request(`/chats/${chatId}/messages`);
  return data;
}

export async function editMessage(messageId, parts) {
  // TODO: verify — try bare `{ parts }` first; if Linq rejects it, fall back
  // to `{ message: { parts } }` per CLAUDE.md §4.2.
  return request(`/messages/${messageId}`, {
    method: "PATCH",
    body: { parts },
  });
}

export async function addReaction(messageId, type, operation = "add") {
  return request(`/messages/${messageId}/reactions`, {
    method: "POST",
    body: { type, operation },
  });
}

export async function updateGroup(chatId, { displayName, iconUrl } = {}) {
  return request(`/chats/${chatId}`, {
    method: "PUT",
    body: {
      ...(displayName ? { display_name: displayName } : {}),
      ...(iconUrl ? { group_chat_icon: iconUrl } : {}),
    },
  });
}

// TODO: verify — endpoint path guessed per CLAUDE.md §4.4, never confirmed
// against the sandbox. Typing indicators are DM-only theater (CLAUDE.md §3),
// so a failure here must never propagate.
export async function typing(chatId) {
  try {
    await request(`/chats/${chatId}/typing`, { method: "POST", body: {} });
  } catch (err) {
    console.error(`[linq] typing(${chatId}) failed (ignored):`, err.message);
  }
}

// The tx.* contract game.js drives (CLAUDE.md §5). server.js passes this;
// sim.js passes a fake with the same shape.
export const liveTransport = {
  send: (chatId, message, opts) => sendMessage(chatId, message, opts),
  createChat,
  react: (messageId, type, operation) => addReaction(messageId, type, operation),
  editMessage,
  updateGroup,
  typing,
};
