// yt-analytics.ts tests — window math, OAuth env handling, report parsing
// (with a mocked fetch), previous-period comparison, and the formatted block.
// No real network. window is WINDOW_DAYS=7, so dates/labels below reflect 7d.

import {
  analyticsWindow,
  previousWindow,
  analyticsIds,
  fetchAnalytics,
  formatAnalyticsBlock,
  type ChannelAnalytics,
} from "./yt-analytics.js";

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

type Captured = { url: string; method?: string; auth?: string };

function installMockFetch(
  responder: (cap: Captured) => { status: number; body: string }
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: any) => {
    const cap: Captured = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method,
      auth: init?.headers?.Authorization,
    };
    const r = responder(cap);
    return new Response(r.body, {
      status: r.status,
      statusText: r.status >= 400 ? "Error" : "OK",
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function setCreds(): void {
  process.env.YT_OAUTH_CLIENT_ID = "cid";
  process.env.YT_OAUTH_CLIENT_SECRET = "secret";
  process.env.YT_OAUTH_REFRESH_TOKEN = "refresh";
}

const CORE_COLS = JSON.stringify([
  { name: "views" },
  { name: "estimatedMinutesWatched" },
  { name: "averageViewDuration" },
  { name: "subscribersGained" },
  { name: "subscribersLost" },
]);

// stateful happy responder: 1st core call = current window, 2nd = previous.
function happyResponderFactory() {
  let coreCalls = 0;
  return (cap: Captured): { status: number; body: string } => {
    if (cap.url.startsWith("https://oauth2.googleapis.com/token")) {
      return { status: 200, body: JSON.stringify({ access_token: "tok-123", expires_in: 3599 }) };
    }
    if (cap.url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
      return { status: 200, body: JSON.stringify({ items: [{ statistics: { viewCount: "2340118" } }] }) };
    }
    if (cap.url.includes("dimensions=subscribedStatus")) {
      return {
        status: 200,
        body: JSON.stringify({
          columnHeaders: [{ name: "subscribedStatus" }, { name: "views" }],
          rows: [["SUBSCRIBED", 47000], ["UNSUBSCRIBED", 77500]],
        }),
      };
    }
    if (cap.url.includes("dimensions=ageGroup")) {
      return {
        status: 200,
        body: JSON.stringify({
          columnHeaders: [{ name: "ageGroup" }, { name: "viewerPercentage" }],
          rows: [
            ["age18-24", 22],
            ["age25-34", 41],
            ["age35-44", 18],
            ["age45-54", 12],
            ["age55-64", 7],
          ],
        }),
      };
    }
    // core (no dimensions): first = current, second = previous
    coreCalls++;
    if (coreCalls === 1) {
      return { status: 200, body: JSON.stringify({ columnHeaders: JSON.parse(CORE_COLS), rows: [[124500, 192600, 252, 400, 80]] }) };
    }
    return { status: 200, body: JSON.stringify({ columnHeaders: JSON.parse(CORE_COLS), rows: [[105000, 171000, 240, 350, 100]] }) };
  };
}

// --- A1: analyticsWindow / previousWindow math (7-day window) ---

console.log("\n--- A1: window math ---");
{
  const now = new Date("2026-06-18T00:00:00Z");
  const w = analyticsWindow(now);
  eq(w.endDate, "2026-06-16", "A1: current endDate = now - 2 days");
  eq(w.startDate, "2026-06-10", "A1: current startDate = endDate - 6 days (7d inclusive)");
  const p = previousWindow(now);
  eq(p.endDate, "2026-06-09", "A1: previous endDate = current start - 1 day");
  eq(p.startDate, "2026-06-03", "A1: previous startDate = prev end - 6 days");
}

// --- A2: missing OAuth env throws a clear error ---

console.log("\n--- A2: missing OAuth credentials throws ---");
{
  delete process.env.YT_OAUTH_CLIENT_ID;
  delete process.env.YT_OAUTH_CLIENT_SECRET;
  delete process.env.YT_OAUTH_REFRESH_TOKEN;
  let threw = false;
  try {
    await fetchAnalytics();
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    ok(/YT_OAUTH_CLIENT_ID/.test(msg), "A2: error names the missing var");
  }
  ok(threw, "A2: fetchAnalytics threw without creds");
}

// --- A3: happy path parses current + previous + lifetime ---

console.log("\n--- A3: happy path parsing ---");
{
  setCreds();
  process.env.YT_DATA_API_KEY = "key";
  process.env.YT_CHANNEL = "UCA_NxRFfbYSG3kOeHak0BjQ";
  const restore = installMockFetch(happyResponderFactory());
  let a: ChannelAnalytics;
  try {
    a = await fetchAnalytics();
  } finally {
    restore();
    delete process.env.YT_DATA_API_KEY;
    delete process.env.YT_CHANNEL;
  }
  eq(a!.views, 124500, "A3: views (current)");
  eq(a!.watchTimeHours, 3210, "A3: watch hours = round(192600/60)");
  eq(a!.subscribersNet, 320, "A3: net subs = gained 400 - lost 80");
  eq(a!.avgViewDurationSec, 252, "A3: avg view duration seconds");
  eq(a!.prevViews, 105000, "A3: prev views (previous window)");
  eq(a!.prevWatchTimeHours, 2850, "A3: prev watch hours = round(171000/60)");
  eq(a!.prevSubscribersNet, 250, "A3: prev net subs = 350 - 100");
  ok(Math.abs((a!.subscribedShare ?? 0) - 47000 / 124500) < 1e-9, "A3: subscribedShare ratio");
  eq(a!.topAgeGroups[0], "age25-34 (41%)", "A3: highest age group first");
  eq(a!.lifetimeViews, 2340118, "A3: lifetime views from Data API");
}

// --- A4: token refresh failure is fatal ---

console.log("\n--- A4: token failure throws ---");
{
  setCreds();
  const restore = installMockFetch((cap) => {
    if (cap.url.startsWith("https://oauth2.googleapis.com/token")) {
      return { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
    }
    return { status: 200, body: "{}" };
  });
  let threw = false;
  try {
    await fetchAnalytics();
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    ok(/token refresh failed/.test(msg), "A4: error mentions token refresh");
  } finally {
    restore();
  }
  ok(threw, "A4: fetchAnalytics threw on bad token");
}

// --- A5: optional calls (dims/lifetime) degrade gracefully ---

console.log("\n--- A5: optional calls degrade gracefully ---");
{
  setCreds();
  const restore = installMockFetch((cap) => {
    if (cap.url.startsWith("https://oauth2.googleapis.com/token")) {
      return { status: 200, body: JSON.stringify({ access_token: "tok" }) };
    }
    if (cap.url.includes("dimensions=")) {
      return { status: 403, body: JSON.stringify({ error: "forbidden" }) };
    }
    // both core calls succeed
    return { status: 200, body: JSON.stringify({ columnHeaders: JSON.parse(CORE_COLS), rows: [[100, 6000, 120, 10, 1]] }) };
  });
  let a: ChannelAnalytics;
  try {
    a = await fetchAnalytics();
  } finally {
    restore();
  }
  eq(a!.views, 100, "A5: core still parsed");
  eq(a!.watchTimeHours, 100, "A5: watch hours from core");
  eq(a!.subscribersNet, 9, "A5: net subs 10 - 1");
  eq(a!.subscribedShare, null, "A5: subscribedShare null when call fails");
  eq(a!.topAgeGroups.length, 0, "A5: topAgeGroups empty when call fails");
  eq(a!.lifetimeViews, null, "A5: lifetimeViews null when no Data API key");
}

// --- A6: current-window core failure is fatal ---

console.log("\n--- A6: core report failure throws ---");
{
  setCreds();
  const restore = installMockFetch((cap) => {
    if (cap.url.startsWith("https://oauth2.googleapis.com/token")) {
      return { status: 200, body: JSON.stringify({ access_token: "tok" }) };
    }
    return { status: 500, body: "boom" };
  });
  let threw = false;
  try {
    await fetchAnalytics();
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    ok(/reports 500/.test(msg), "A6: error mentions reports 500");
  } finally {
    restore();
  }
  ok(threw, "A6: fetchAnalytics threw on core failure");
}

// --- A7: empty report rows produce zeros, not a crash ---

console.log("\n--- A7: empty rows tolerated ---");
{
  setCreds();
  const restore = installMockFetch((cap) => {
    if (cap.url.startsWith("https://oauth2.googleapis.com/token")) {
      return { status: 200, body: JSON.stringify({ access_token: "tok" }) };
    }
    return { status: 200, body: JSON.stringify({ columnHeaders: [], rows: [] }) };
  });
  let a: ChannelAnalytics;
  try {
    a = await fetchAnalytics();
  } finally {
    restore();
  }
  eq(a!.views, 0, "A7: views defaults to 0");
  eq(a!.watchTimeHours, 0, "A7: watch hours defaults to 0");
  eq(a!.subscribersNet, 0, "A7: net subs defaults to 0");
  eq(a!.prevViews, 0, "A7: prev views defaults to 0");
}

// --- A8: formatAnalyticsBlock renders the full block with comparisons ---

console.log("\n--- A8: formatAnalyticsBlock full ---");
{
  const block = formatAnalyticsBlock({
    startDate: "2026-06-10",
    endDate: "2026-06-16",
    views: 120000,
    watchTimeHours: 3300,
    subscribersNet: 320,
    avgViewDurationSec: 252,
    prevViews: 100000, // +20%
    prevWatchTimeHours: 3000, // +10%
    prevSubscribersNet: 400, // -20%
    subscribedShare: 47000 / 124500,
    topAgeGroups: ["age25-34 (41%)", "age18-24 (22%)"],
    lifetimeViews: 2340118,
  });
  ok(block.includes("📊 Last 7 days (2026-06-10 → 2026-06-16)"), "A8: header with window");
  ok(block.includes("Views: 120,000  (↑ 20% vs prev 7d)"), "A8: views + comparison");
  ok(block.includes("Watch time: 3,300 hrs  (↑ 10% vs prev 7d)"), "A8: watch time + comparison");
  ok(block.includes("Subscribers: +320  (↓ 20% vs prev 7d)"), "A8: net subs + comparison");
  ok(block.includes("Avg view duration: 4:12"), "A8: duration mm:ss");
  ok(block.includes("Audience: 38% subscribed"), "A8: subscribed pct rounded");
  ok(block.includes("Top age groups: age25-34 (41%), age18-24 (22%)"), "A8: age groups");
  ok(block.includes("Total channel views: 2,340,118"), "A8: lifetime views");
  ok(!block.includes("impressions"), "A8: impressions line omitted (commented out for now)");
}

// --- A9: formatAnalyticsBlock omits comparisons/optional lines when absent ---

console.log("\n--- A9: formatAnalyticsBlock minimal ---");
{
  const block = formatAnalyticsBlock({
    startDate: "2026-06-10",
    endDate: "2026-06-16",
    views: 0,
    watchTimeHours: 0,
    subscribersNet: 0,
    avgViewDurationSec: 5,
    prevViews: 0,
    prevWatchTimeHours: 0,
    prevSubscribersNet: 0,
    subscribedShare: null,
    topAgeGroups: [],
    lifetimeViews: null,
  });
  ok(!block.includes("vs prev 7d"), "A9: no comparison when prev baseline is 0");
  ok(block.includes("Subscribers: +0"), "A9: zero net subs shown as +0");
  ok(!block.includes("Audience:"), "A9: no audience line when share null");
  ok(!block.includes("Top age groups:"), "A9: no age line when empty");
  ok(!block.includes("Total channel views:"), "A9: no lifetime line when null");
  ok(block.includes("Avg view duration: 0:05"), "A9: zero-padded seconds");
}

// --- A10: analyticsIds prefers an explicit UC channel id over channel==MINE ---

console.log("\n--- A10: analyticsIds selector ---");
{
  const saved = process.env.YT_CHANNEL;
  process.env.YT_CHANNEL = "UCA_NxRFfbYSG3kOeHak0BjQ";
  eq(analyticsIds(), "channel==UCA_NxRFfbYSG3kOeHak0BjQ", "A10: explicit id when YT_CHANNEL is a UC id");
  process.env.YT_CHANNEL = "@somehandle";
  eq(analyticsIds(), "channel==MINE", "A10: falls back to MINE for a non-UC value");
  delete process.env.YT_CHANNEL;
  eq(analyticsIds(), "channel==MINE", "A10: falls back to MINE when unset");
  if (saved === undefined) delete process.env.YT_CHANNEL;
  else process.env.YT_CHANNEL = saved;
}

console.log(`\n--- summary: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
