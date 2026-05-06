// posts the formatted status message to the org's notifications relay.
// the relay does the actual telegram-bot work; this side just speaks HTTP.
//
// env vars:
//   NOTIFY_URL      defaults to the eagle3dstreaming relay
//   NOTIFY_CHAT_ID  required. no default — we don't want a stale chat_id
//                   in source ever sending real updates to a test group.

const DEFAULT_URL = "https://notifications.eagle3dstreaming.com/message_sent";
const HTTP_TIMEOUT_MS = 15_000;

function url(): string {
  return process.env.NOTIFY_URL?.trim() || DEFAULT_URL;
}

function chatId(): number {
  const raw = process.env.NOTIFY_CHAT_ID;
  if (!raw || !raw.trim()) {
    throw new Error(
      "notify: NOTIFY_CHAT_ID env var not set. point it at the relay's group id (e.g. -5100088425) before running the gateway."
    );
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`notify: NOTIFY_CHAT_ID="${raw}" isn't a valid integer`);
  }
  return n;
}

export async function postToNotificationApi(message: string): Promise<{
  status: number;
  bodySnippet: string;
}> {
  if (!message || !message.trim()) {
    throw new Error("notify: message is empty");
  }
  const body = JSON.stringify({ message, input_chat_id: chatId() });
  const res = await fetch(url(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `notify api ${res.status}: ${text.slice(0, 200) || "(empty body)"}`
    );
  }
  return { status: res.status, bodySnippet: text.slice(0, 200) };
}
