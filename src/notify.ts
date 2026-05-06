// thin POST to the eagle3dstreaming notifications relay. no auth header on
// the wire — the relay is gated by something else (network/IP). url and
// chat_id are env-overridable so the same code works for staging or other
// groups without a rebuild.

const DEFAULT_URL = "https://notifications.eagle3dstreaming.com/message_sent";
const DEFAULT_CHAT_ID = -5100088424;
const HTTP_TIMEOUT_MS = 15_000;

function url(): string {
  return process.env.NOTIFY_URL?.trim() || DEFAULT_URL;
}

function chatId(): number {
  const v = process.env.NOTIFY_CHAT_ID;
  if (v && v.trim()) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_CHAT_ID;
}

export async function postToNotificationApi(message: string): Promise<{
  status: number;
  bodySnippet: string;
}> {
  if (!message || !message.trim()) {
    throw new Error("notify: message is empty");
  }
  const res = await fetch(url(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, input_chat_id: chatId() }),
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
