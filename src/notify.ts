// POST to the eagle3dstreaming relay which fans out to Telegram.
// NOTIFY_CHAT_ID is required at call time — never default it; a stale id
// in source would silently spam a test group on real runs.

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
