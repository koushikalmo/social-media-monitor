// format.ts tests — verify every branch of formatStatusReport produces
// the expected user-visible Telegram text. no network, no LLM.

import { formatStatusReport } from "./format.js";
import type { StatusReport } from "./diff.js";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) { console.error("FAIL:", msg); failed++; return; }
  console.log("ok  ", msg);
  passed++;
}
function contains(haystack: string, needle: string, msg: string): void {
  ok(haystack.includes(needle), msg + ` — searching for "${needle}"`);
}
function notContains(haystack: string, needle: string, msg: string): void {
  ok(!haystack.includes(needle), msg + ` — should NOT contain "${needle}"`);
}

function baseReport(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    channelId: "UCTEST",
    channelTitle: "Test Channel",
    scrapedAt: "2026-05-11T12:00:00Z",
    isFirstRun: false,
    scrapeMode: "full",
    subscriberBefore: 1000,
    subscriberAfter: 1000,
    subscriberDelta: 0,
    videoChanges: [],
    allVideos: [],
    warnings: [],
    ...overrides,
  };
}

// ---------- F1: first-run baseline ----------

console.log("\n--- F1: first run baseline ---");
{
  const r = baseReport({
    isFirstRun: true,
    subscriberBefore: null,
    subscriberDelta: null,
    allVideos: [
      {
        videoId: "vid1",
        title: "First Video",
        likeBefore: null, likeAfter: 10, likeDelta: null,
        commentBefore: null, commentAfter: 2, commentDelta: null,
        viewBefore: null, viewAfter: 100, viewDelta: null,
        likeBecameNull: false, commentBecameNull: false,
      },
      {
        videoId: "vid2",
        title: "Second Video",
        likeBefore: null, likeAfter: null, likeDelta: null,
        commentBefore: null, commentAfter: null, commentDelta: null,
        viewBefore: null, viewAfter: 50, viewDelta: null,
        likeBecameNull: false, commentBecameNull: false,
      },
    ],
  });
  const out = formatStatusReport(r);
  contains(out, "Test Channel", "F1: includes channel title");
  contains(out, "initial baseline", "F1: marks as initial baseline");
  contains(out, "Subscribers: 1,000", "F1: shows current subscriber count");
  contains(out, "Tracking 2 recent videos", "F1: shows video count");
  contains(out, "First Video", "F1: includes first video title");
  contains(out, "Second Video", "F1: includes second video title");
  contains(out, "likes: 10", "F1: includes first video's like count");
  contains(out, "views: 50", "F1: video 2's view count still shown");
  notContains(out, "likes: —", "F1: null like metric omitted (not rendered as em-dash)");
  notContains(out, "comments: —", "F1: null comment metric omitted");
  contains(out, "Saved baseline", "F1: ends with baseline-saved footer");
  notContains(out, "since last check", "F1: no delta language on first run");
}

// ---------- F2: no changes ----------

console.log("\n--- F2: no changes since last run ---");
{
  const r = baseReport({
    isFirstRun: false,
    subscriberBefore: 1000,
    subscriberAfter: 1000,
    subscriberDelta: 0,
    videoChanges: [],
  });
  const out = formatStatusReport(r);
  contains(out, "Test Channel", "F2: includes channel title");
  contains(out, "No changes since last check", "F2: no-change message");
  contains(out, "Subscribers steady at 1,000", "F2: reports steady count");
  notContains(out, "initial baseline", "F2: not labeled baseline");
  notContains(out, "3-hour status", "F2: not the delta header");
}

// ---------- F3: delta — subscribers + multi-metric per-video ----------

console.log("\n--- F3: subscriber + per-video delta ---");
{
  const r = baseReport({
    isFirstRun: false,
    subscriberBefore: 950,
    subscriberAfter: 1000,
    subscriberDelta: 50,
    videoChanges: [
      {
        videoId: "vid1",
        title: "Hot Video",
        likeBefore: 10, likeAfter: 13, likeDelta: 3,
        commentBefore: 2, commentAfter: 4, commentDelta: 2,
        viewBefore: 100, viewAfter: 240, viewDelta: 140,
        likeBecameNull: false, commentBecameNull: false,
      },
    ],
    allVideos: [],
  });
  const out = formatStatusReport(r);
  contains(out, "3-hour status", "F3: delta header");
  contains(out, "Subscribers: 1,000", "F3: current sub count");
  contains(out, "+50", "F3: subscriber delta with sign");
  contains(out, "since last check", "F3: delta language");
  contains(out, "Hot Video", "F3: video title");
  contains(out, "likes: 10 → 13", "F3: like before→after");
  contains(out, "(+3)", "F3: like delta");
  contains(out, "comments: 2 → 4", "F3: comment before→after");
  contains(out, "(+2)", "F3: comment delta");
  contains(out, "views: 100 → 240", "F3: view before→after");
  contains(out, "(+140)", "F3: view delta");
  notContains(out, "initial baseline", "F3: not baseline");
}

// ---------- F4: negative deltas ----------

console.log("\n--- F4: negative deltas display correctly ---");
{
  const r = baseReport({
    isFirstRun: false,
    subscriberBefore: 1050,
    subscriberAfter: 1000,
    subscriberDelta: -50,
    videoChanges: [
      {
        videoId: "vid1",
        title: "Cooling Video",
        likeBefore: 15, likeAfter: 12, likeDelta: -3,
        commentBefore: 0, commentAfter: 0, commentDelta: 0,
        viewBefore: 300, viewAfter: 290, viewDelta: -10,
        likeBecameNull: false, commentBecameNull: false,
      },
    ],
  });
  const out = formatStatusReport(r);
  contains(out, "-50", "F4: negative subscriber delta");
  contains(out, "(-3)", "F4: negative like delta");
  contains(out, "(-10)", "F4: negative view delta");
  notContains(out, "(0)", "F4: zero-delta comments line skipped");
  notContains(out, "comments:", "F4: comments section omitted when no change");
}

// ---------- F5: channel-only mode footer ----------

console.log("\n--- F5: channel-only scrape adds note ---");
{
  const r = baseReport({
    isFirstRun: true,
    scrapeMode: "channel-only",
    subscriberBefore: null,
    subscriberDelta: null,
    allVideos: [],
  });
  const out = formatStatusReport(r);
  contains(out, "channel-only scrape", "F5: notes channel-only mode");
  contains(out, "unavailable", "F5: explains likes/comments unavailable");
}

// ---------- F6: partial mode footer ----------

console.log("\n--- F6: partial scrape adds note ---");
{
  const r = baseReport({
    isFirstRun: false,
    scrapeMode: "partial",
    subscriberBefore: 1000,
    subscriberAfter: 1000,
    subscriberDelta: 0,
    videoChanges: [],
    warnings: ["video xyz failed: HTTP 429"],
  });
  const out = formatStatusReport(r);
  contains(out, "partial scrape", "F6: notes partial mode");
  contains(out, "note:", "F6: includes warning note");
  contains(out, "HTTP 429", "F6: warning text propagates");
}

// ---------- F7: hidden subscriber count ----------

console.log("\n--- F7: subscriberAfter=null renders cleanly ---");
{
  const r = baseReport({
    isFirstRun: true,
    subscriberBefore: null,
    subscriberAfter: null,
    subscriberDelta: null,
  });
  const out = formatStatusReport(r);
  contains(out, "Subscribers: —", "F7: em-dash for null sub count");
  notContains(out, "Subscribers: null", "F7: never shows literal 'null'");
}

// ---------- F8: large numbers formatted with commas ----------

console.log("\n--- F8: large numbers use thousand-separators ---");
{
  const r = baseReport({
    isFirstRun: false,
    subscriberBefore: 1_234_567,
    subscriberAfter: 1_234_700,
    subscriberDelta: 133,
    videoChanges: [
      {
        videoId: "vid1",
        title: "Big Video",
        likeBefore: 12345, likeAfter: 12567, likeDelta: 222,
        commentBefore: 100, commentAfter: 105, commentDelta: 5,
        viewBefore: 999_999, viewAfter: 1_000_500, viewDelta: 501,
        likeBecameNull: false, commentBecameNull: false,
      },
    ],
  });
  const out = formatStatusReport(r);
  contains(out, "1,234,700", "F8: large sub count formatted");
  contains(out, "999,999 → 1,000,500", "F8: large view counts formatted");
  contains(out, "(+501)", "F8: delta with sign");
}

// ---------- F9: large baseline lists every video (no truncation) ----------

console.log("\n--- F9: baseline with 30 videos lists all of them ---");
{
  const r = baseReport({
    isFirstRun: true,
    subscriberBefore: null,
    subscriberDelta: null,
    allVideos: Array.from({ length: 30 }, (_, i) => ({
      videoId: `vid${i.toString().padStart(2, "0")}`,
      title: `Video ${i} — a reasonably long title to simulate real youtube titles`,
      likeBefore: null, likeAfter: 10 + i, likeDelta: null,
      commentBefore: null, commentAfter: i, commentDelta: null,
      viewBefore: null, viewAfter: 1000 + i * 50, viewDelta: null,
      likeBecameNull: false, commentBecameNull: false,
    })),
  });
  const out = formatStatusReport(r);
  contains(out, "Tracking 30 recent videos", "F9: header says 30");
  contains(out, "Video 0 ", "F9: video 0 included");
  contains(out, "Video 14 ", "F9: video 14 included");
  contains(out, "Video 15 ", "F9: video 15 included (no truncation)");
  contains(out, "Video 29 ", "F9: last video included");
  notContains(out, "more videos", "F9: no truncation footer");
}

// ---------- F10: views-only baseline ----------

console.log("\n--- F10: views-only baseline renders just views per video ---");
{
  const r = baseReport({
    isFirstRun: true,
    scrapeMode: "views-only",
    subscriberBefore: null,
    subscriberDelta: null,
    allVideos: [
      {
        videoId: "vid1", title: "Views-Only Video 1",
        likeBefore: null, likeAfter: null, likeDelta: null,
        commentBefore: null, commentAfter: null, commentDelta: null,
        viewBefore: null, viewAfter: 1920, viewDelta: null,
        likeBecameNull: false, commentBecameNull: false,
      },
      {
        videoId: "vid2", title: "Views-Only Video 2",
        likeBefore: null, likeAfter: null, likeDelta: null,
        commentBefore: null, commentAfter: null, commentDelta: null,
        viewBefore: null, viewAfter: 62, viewDelta: null,
        likeBecameNull: false, commentBecameNull: false,
      },
    ],
  });
  const out = formatStatusReport(r);
  contains(out, "views: 1,920", "F10: video 1 view count shown");
  contains(out, "views: 62", "F10: video 2 view count shown");
  notContains(out, "likes:", "F10: no 'likes:' anywhere when all videos have null likes");
  notContains(out, "comments:", "F10: no 'comments:' anywhere when all videos have null comments");
  notContains(out, "views-only scrape", "F10: views-only mode doesn't emit degradation footer");
  notContains(out, "channel-only scrape", "F10: views-only ≠ channel-only");
}

console.log(`\n--- summary: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed === 0 ? 0 : 1);
