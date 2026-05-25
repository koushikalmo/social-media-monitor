// notify.ts tests — env handling + body shape with mocked fetch

import { postToNotificationApi } from "./notify.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
    return;
  }
  console.log("ok  ", msg);
  passed++;
}
function eq<T>(a: T, b: T, msg: string): void {
  if (a !== b) {
    console.error(`FAIL: ${msg}\n   expected: ${JSON.stringify(b)}\n   actual:   ${JSON.stringify(a)}`);
    failed++;
    return;
  }
  console.log("ok  ", msg);
  passed++;
}

type Captured = {
  url?: string;
  method?: string;
  bodyText?: string;
  contentType?: string;
};

function installMockFetch(handler: (cap: Captured) => { status: number; body: string }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const cap: Captured = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method,
      bodyText: typeof init?.body === "string" ? init.body : "",
      contentType: init?.headers?.["Content-Type"],
    };
    const r = handler(cap);
    return new Response(r.body, {
      status: r.status,
      statusText: r.status >= 400 ? "Error" : "OK",
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// --- N1: missing NOTIFY_CHAT_ID throws clearly ---

console.log("\n--- N1: missing NOTIFY_CHAT_ID throws ---");
{
  delete process.env.NOTIFY_CHAT_ID;
  let threw = false;
  try {
    await postToNotificationApi("anything");
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    ok(/NOTIFY_CHAT_ID/.test(msg), "N1: error mentions NOTIFY_CHAT_ID");
  }
  ok(threw, "N1: postToNotificationApi threw");
}

// --- N2: non-numeric NOTIFY_CHAT_ID throws ---

console.log("\n--- N2: garbage NOTIFY_CHAT_ID throws ---");
{
  process.env.NOTIFY_CHAT_ID = "not-a-number";
  let threw = false;
  try {
    await postToNotificationApi("hi");
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    ok(/valid integer/.test(msg), "N2: error mentions valid integer");
  }
  ok(threw, "N2: threw");
}

// --- N3: empty message throws ---

console.log("\n--- N3: empty message throws ---");
{
  process.env.NOTIFY_CHAT_ID = "-5100088425";
  let threw = false;
  try {
    await postToNotificationApi("   ");
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    ok(/empty/.test(msg), "N3: error mentions empty");
  }
  ok(threw, "N3: threw");
}

// --- N4: happy path posts the right body shape ---

console.log("\n--- N4: body shape matches the relay contract ---");
{
  process.env.NOTIFY_CHAT_ID = "-5100088425";
  delete process.env.NOTIFY_URL;
  let captured: Captured = {};
  const restore = installMockFetch((cap) => {
    captured = cap;
    return { status: 200, body: '{"success":[{}]}' };
  });
  try {
    const r = await postToNotificationApi("hello world");
    eq(r.status, 200, "N4: status=200");
    eq(captured.method, "POST", "N4: POST");
    eq(captured.contentType, "application/json", "N4: content-type set");
    eq(
      captured.url,
      "https://notifications.eagle3dstreaming.com/message_sent",
      "N4: hits default relay url"
    );
    const body = JSON.parse(captured.bodyText ?? "{}");
    eq(body.message, "hello world", "N4: body.message preserved");
    eq(body.input_chat_id, -5100088425, "N4: body.input_chat_id matches env");
    // make sure we DIDN'T accidentally use field name 'chat_id' instead
    ok(!("chat_id" in body), "N4: field is input_chat_id, not chat_id");
  } finally {
    restore();
  }
}

// --- N5: NOTIFY_URL override is honored ---

console.log("\n--- N5: NOTIFY_URL env override ---");
{
  process.env.NOTIFY_URL = "https://staging.example.com/notify";
  process.env.NOTIFY_CHAT_ID = "-99";
  let captured: Captured = {};
  const restore = installMockFetch((cap) => {
    captured = cap;
    return { status: 200, body: "{}" };
  });
  try {
    await postToNotificationApi("test");
    eq(captured.url, "https://staging.example.com/notify", "N5: hits the override url");
  } finally {
    restore();
    delete process.env.NOTIFY_URL;
  }
}

// --- N6: relay 4xx surfaces a clear error ---

console.log("\n--- N6: relay 4xx response surfaces a clean error ---");
{
  process.env.NOTIFY_CHAT_ID = "-5100088425";
  const restore = installMockFetch(() => ({ status: 400, body: '{"error":"chat not found"}' }));
  try {
    let threw = false;
    try {
      await postToNotificationApi("test");
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      ok(/notify api 400/.test(msg), "N6: error mentions HTTP code");
      ok(/chat not found/.test(msg), "N6: error includes relay's body snippet");
    }
    ok(threw, "N6: threw on 4xx");
  } finally {
    restore();
  }
}

// --- N7: TELEGRAM_BOT_TOKEN switches to direct Bot API ---

console.log("\n--- N7: direct Bot API mode ---");
{
  process.env.NOTIFY_CHAT_ID = "-1001234567890";
  process.env.TELEGRAM_BOT_TOKEN = "8370042839:FAKE_TOKEN_abc123";
  delete process.env.NOTIFY_URL;
  let captured: Captured = {};
  const restore = installMockFetch((cap) => {
    captured = cap;
    return { status: 200, body: '{"ok":true,"result":{"message_id":42}}' };
  });
  try {
    const r = await postToNotificationApi("direct test");
    eq(r.status, 200, "N7: status=200");
    eq(
      captured.url,
      "https://api.telegram.org/bot8370042839:FAKE_TOKEN_abc123/sendMessage",
      "N7: hits Telegram Bot API URL with token"
    );
    const body = JSON.parse(captured.bodyText ?? "{}");
    eq(body.chat_id, -1001234567890, "N7: body.chat_id (Telegram field name)");
    eq(body.text, "direct test", "N7: body.text (Telegram field name)");
    ok(!("message" in body), "N7: relay-style 'message' field absent in direct mode");
    ok(!("input_chat_id" in body), "N7: relay-style 'input_chat_id' field absent in direct mode");
  } finally {
    restore();
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
}

// --- N8: bot token wins over NOTIFY_URL ---

console.log("\n--- N8: TELEGRAM_BOT_TOKEN takes precedence over NOTIFY_URL ---");
{
  process.env.NOTIFY_CHAT_ID = "-99";
  process.env.TELEGRAM_BOT_TOKEN = "xxx:yyy";
  process.env.NOTIFY_URL = "https://should-be-ignored.example.com/x";
  let captured: Captured = {};
  const restore = installMockFetch((cap) => {
    captured = cap;
    return { status: 200, body: '{"ok":true}' };
  });
  try {
    await postToNotificationApi("test");
    ok(
      captured.url?.startsWith("https://api.telegram.org/") ?? false,
      "N8: bot token wins; URL points at Telegram API"
    );
  } finally {
    restore();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NOTIFY_URL;
  }
}

console.log(`\n--- summary: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed === 0 ? 0 : 1);
