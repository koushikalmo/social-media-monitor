// mocked-fetch tests for both providers and the fallback chain.

import { getExactSubscriberCount } from "./yt-subscribers.js";

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

type MockHandler = (url: string) => { status: number; body: string };

function installMockFetch(handler: MockHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    const r = handler(url);
    return new Response(r.body, {
      status: r.status,
      statusText: r.status >= 400 ? "Error" : "OK",
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// --- S1: mixerno happy path ---

console.log("\n--- S1: mixerno returns exact count ---");
{
  const restore = installMockFetch((url) => {
    if (url.includes("mixerno.space")) {
      return {
        status: 200,
        body: JSON.stringify({
          counts: [
            { value: "subscribers", count: 1247 },
            { value: "views", count: 42137 },
          ],
        }),
      };
    }
    return { status: 500, body: "" };
  });
  try {
    const r = await getExactSubscriberCount("UCTEST", "mixerno");
    eq(r.count, 1247, "S1: count parsed from mixerno");
    eq(r.source, "mixerno", "S1: source label");
    eq(r.error, null, "S1: no error");
  } finally {
    restore();
  }
}

// --- S2: livecounts happy path ---

console.log("\n--- S2: livecounts returns exact count ---");
{
  const restore = installMockFetch((url) => {
    if (url.includes("livecounts.io")) {
      return { status: 200, body: JSON.stringify({ followerCount: 1247 }) };
    }
    return { status: 500, body: "" };
  });
  try {
    const r = await getExactSubscriberCount("UCTEST", "livecounts");
    eq(r.count, 1247, "S2: count parsed from livecounts");
    eq(r.source, "livecounts", "S2: source label");
  } finally {
    restore();
  }
}

// --- S3: mixerno down, livecounts up → falls over ---

console.log("\n--- S3: mixerno 500 → livecounts answers ---");
{
  const restore = installMockFetch((url) => {
    if (url.includes("mixerno.space")) return { status: 500, body: "internal error" };
    if (url.includes("livecounts.io")) {
      return { status: 200, body: JSON.stringify({ subscribers: 999 }) };
    }
    return { status: 500, body: "" };
  });
  try {
    const r = await getExactSubscriberCount("UCTEST", "mixerno");
    eq(r.count, 999, "S3: livecounts picked up after mixerno failure");
    eq(r.source, "livecounts", "S3: source reflects fallback choice");
  } finally {
    restore();
  }
}

// --- S4: both down → returns fallback signal ---

console.log("\n--- S4: both providers fail → count=null, source=fallback ---");
{
  const restore = installMockFetch(() => ({ status: 503, body: "rate limited" }));
  try {
    const r = await getExactSubscriberCount("UCTEST", "mixerno");
    eq(r.count, null, "S4: count is null");
    eq(r.source, "fallback", "S4: source=fallback");
    ok(r.error !== null && r.error.length > 0, "S4: error message populated");
    ok(/503/.test(r.error ?? ""), "S4: error mentions HTTP 503");
  } finally {
    restore();
  }
}

// --- S5: mixerno returns malformed payload → falls over to livecounts ---

console.log("\n--- S5: malformed mixerno payload triggers fallback ---");
{
  const restore = installMockFetch((url) => {
    if (url.includes("mixerno.space")) {
      return { status: 200, body: JSON.stringify({ wrong: "shape" }) };
    }
    if (url.includes("livecounts.io")) {
      return { status: 200, body: JSON.stringify({ followerCount: 500 }) };
    }
    return { status: 500, body: "" };
  });
  try {
    const r = await getExactSubscriberCount("UCTEST", "mixerno");
    eq(r.count, 500, "S5: livecounts answered after malformed mixerno");
    eq(r.source, "livecounts", "S5: source=livecounts");
  } finally {
    restore();
  }
}

// --- S6: negative subscriber count rejected ---

console.log("\n--- S6: rejects nonsense (negative) count ---");
{
  const restore = installMockFetch(() => ({
    status: 200,
    body: JSON.stringify({ counts: [{ value: "subscribers", count: -42 }] }),
  }));
  try {
    const r = await getExactSubscriberCount("UCTEST", "mixerno");
    eq(r.count, null, "S6: count=null because negative was rejected");
    eq(r.source, "fallback", "S6: source=fallback");
  } finally {
    restore();
  }
}

console.log(`\n--- summary: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed === 0 ? 0 : 1);
