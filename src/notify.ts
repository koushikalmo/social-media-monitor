// POST to Telegram. two delivery paths:
//   TELEGRAM_BOT_TOKEN set → direct Bot API (personal/local testing)
//   otherwise              → eagle3dstreaming relay (production)
// NOTIFY_CHAT_ID is required at call time — never default it; a stale id
// in source would silently spam a test group on real runs.

const RELAY_URL = "https://notifications.eagle3dstreaming.com/message_sent";
const HTTP_TIMEOUT_MS = 15_000;
// telegram hard caps a single message at 4096 chars; 4000 leaves headroom for
// the unicode emoji + the rendering. anything longer is split into N messages.
const TELEGRAM_SAFE_CHARS = 4000;
const INTER_CHUNK_DELAY_MS = 500;

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

// a "block" = one top-level line (no leading space) plus the indented lines that
// trail it. that's the unit we refuse to split, so a video's "• title" never
// gets divorced from its url/views lines across a message boundary. relies on
// format.ts indenting continuation lines — top-level-only text degrades to
// one-line-per-block, i.e. the old line-wise behaviour.
function toBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const isContinuation = current.length > 0 && /^\s/.test(line);
    if (isContinuation) {
      current.push(line);
    } else {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [line];
    }
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

// escape hatch for the pathological case: a single block bigger than the cap.
// prefer line boundaries; only ever hard-slice a line that's itself > maxChars
// (real video entries never are, so in practice this just splits on newlines).
function splitOversized(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current.length === 0 ? line : current + "\n" + line;
    if (candidate.length > maxChars) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      let rest = line;
      while (rest.length > maxChars) {
        out.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

// greedily pack blocks into <=maxChars pieces so each fits Telegram's cap while
// keeping entries whole. exported for tests. invariant: chunks.join("\n") ===
// message, as long as no single line exceeds maxChars (titles never do).
export function chunkMessage(message: string, maxChars = TELEGRAM_SAFE_CHARS): string[] {
  if (message.length <= maxChars) return [message];
  const chunks: string[] = [];
  let current = "";
  for (const block of toBlocks(message.split("\n"))) {
    if (block.length > maxChars) {
      // block can't fit alone: flush what we have, then hard-split it.
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      const parts = splitOversized(block, maxChars);
      for (let i = 0; i < parts.length - 1; i++) chunks.push(parts[i]);
      current = parts[parts.length - 1];
      continue;
    }
    const candidate = current.length === 0 ? block : current + "\n" + block;
    if (candidate.length > maxChars) {
      if (current.length > 0) chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function postOnce(message: string): Promise<{ status: number; bodySnippet: string }> {
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
    throw new Error(`notify api ${res.status}: ${text.slice(0, 200) || "(empty body)"}`);
  }
  return { status: res.status, bodySnippet: text.slice(0, 200) };
}

export async function postToNotificationApi(message: string): Promise<{
  status: number;
  bodySnippet: string;
}> {
  if (!message || !message.trim()) {
    throw new Error("notify: message is empty");
  }
  const chunks = chunkMessage(message);
  if (chunks.length === 1) return postOnce(chunks[0]);
  let first: { status: number; bodySnippet: string } | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const r = await postOnce(chunks[i]);
    if (i === 0) first = r;
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
    }
  }
  return first as { status: number; bodySnippet: string };
}
