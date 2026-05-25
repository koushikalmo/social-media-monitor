// posts the status message to Telegram. two delivery paths:
//   - TELEGRAM_BOT_TOKEN set → direct Bot API (personal/local testing)
//   - otherwise               → eagle3dstreaming relay (production)
// NOTIFY_CHAT_ID is required at call time — never default it; a stale id
// in source would silently spam a test group on real runs.

const RELAY_URL = "https://notifications.eagle3dstreaming.com/message_sent";
const HTTP_TIMEOUT_MS = 15_000;

function chatId(): number {
  const raw = process.env.NOTIFY_CHAT_ID;
  if (!raw || !raw.trim()) {
    throw new Error(
      "notify: NOTIFY_CHAT_ID env var not set. point it at the chat/channel id (e.g. -5100088425) before running."
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
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  let url: string;
  let body: string;
  if (botToken) {
    url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    body = JSON.stringify({ chat_id: chatId(), text: message });
  } else {
    url = process.env.NOTIFY_URL?.trim() || RELAY_URL;
    body = JSON.stringify({ message, input_chat_id: chatId() });
  }
  const res = await fetch(url, {
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
