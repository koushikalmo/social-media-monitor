// unit tests for diff/state — synthetic snapshots, no network

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeReport, nextStateFrom } from "./diff.js";
import { loadState, saveState, stateFilePath } from "./state.js";
import type { ChannelSnapshot } from "./scrape.js";
import type { ChannelState } from "./state.js";

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

function snap(overrides: Partial<ChannelSnapshot> = {}): ChannelSnapshot {
  return {
    channelId: "UCTEST1234567890ABCDEFG",
    channelTitle: "Test Channel",
    subscriberCount: 1000,
    subscriberCountText: "1K subscribers",
    scrapedAt: "2026-05-06T12:00:00.000Z",
    mode: "full",
    videos: [
      {
        videoId: "v1",
        title: "Video One",
        viewCount: 100,
        viewCountText: "100 views",
        likeCount: 10,
        likeCountText: "",
        commentCount: 2,
      },
      {
        videoId: "v2",
        title: "Video Two",
        viewCount: 200,
        viewCountText: "200 views",
        likeCount: 25,
        likeCountText: "",
        commentCount: 5,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

// --- D1: first run produces baseline-style report ---

console.log("\n--- D1: first run is baseline (deltas null) ---");
{
  const r = computeReport(snap(), null);
  ok(r.isFirstRun, "D1: isFirstRun=true");
  eq(r.subscriberBefore, null, "D1: subscriberBefore=null");
  eq(r.subscriberAfter, 1000, "D1: subscriberAfter=1000");
  eq(r.subscriberDelta, null, "D1: subscriberDelta=null on first run");
  eq(r.videoChanges.length, 0, "D1: no per-video changes");
  eq(r.allVideos.length, 2, "D1: allVideos populated");
  eq(r.allVideos[0].likeDelta, null, "D1: video delta is null");
  eq(r.allVideos[0].likeAfter, 10, "D1: video likeAfter present");
}

// --- D2: subsequent run with no actual changes ---

console.log("\n--- D2: no changes since last run ---");
{
  const prev: ChannelState = {
    channelId: "UCTEST1234567890ABCDEFG",
    channelTitle: "Test Channel",
    lastRun: "2026-05-06T09:00:00.000Z",
    subscriberCount: 1000,
    videos: {
      v1: { title: "Video One", likeCount: 10, commentCount: 2, viewCount: 100 },
      v2: { title: "Video Two", likeCount: 25, commentCount: 5, viewCount: 200 },
    },
  };
  const r = computeReport(snap(), prev);
  eq(r.subscriberDelta, 0, "D2: sub delta = 0");
  eq(r.videoChanges.length, 0, "D2: no video changes");
}

// --- D3: subscriber + per-video deltas ---

console.log("\n--- D3: subscriber + like + comment + view deltas ---");
{
  const prev: ChannelState = {
    channelId: "UCTEST1234567890ABCDEFG",
    channelTitle: "Test Channel",
    lastRun: "2026-05-06T09:00:00.000Z",
    subscriberCount: 995,
    videos: {
      v1: { title: "Video One", likeCount: 8, commentCount: 1, viewCount: 90 },
      v2: { title: "Video Two", likeCount: 25, commentCount: 5, viewCount: 200 },
    },
  };
  const r = computeReport(snap(), prev);
  eq(r.subscriberDelta, 5, "D3: sub delta = +5");
  eq(r.videoChanges.length, 1, "D3: only v1 changed");
  eq(r.videoChanges[0].videoId, "v1", "D3: change is on v1");
  eq(r.videoChanges[0].likeDelta, 2, "D3: v1 like delta = +2");
  eq(r.videoChanges[0].commentDelta, 1, "D3: v1 comment delta = +1");
  eq(r.videoChanges[0].viewDelta, 10, "D3: v1 view delta = +10");
}

// --- D4: like becoming null surfaces flag ---

console.log("\n--- D4: like turning null trips likeBecameNull flag ---");
{
  const prev: ChannelState = {
    channelId: "UCTEST1234567890ABCDEFG",
    channelTitle: "Test Channel",
    lastRun: "2026-05-06T09:00:00.000Z",
    subscriberCount: 1000,
    videos: {
      v1: { title: "Video One", likeCount: 10, commentCount: 2, viewCount: 100 },
      v2: { title: "Video Two", likeCount: 25, commentCount: 5, viewCount: 200 },
    },
  };
  const blanked = snap({
    videos: [
      {
        videoId: "v1",
        title: "Video One",
        viewCount: 100,
        viewCountText: "100 views",
        likeCount: null,
        likeCountText: "",
        commentCount: 2,
      },
      {
        videoId: "v2",
        title: "Video Two",
        viewCount: 200,
        viewCountText: "200 views",
        likeCount: 25,
        likeCountText: "",
        commentCount: 5,
      },
    ],
  });
  const r = computeReport(blanked, prev);
  ok(r.allVideos[0].likeBecameNull, "D4: likeBecameNull true on v1");
  eq(r.allVideos[0].likeDelta, null, "D4: delta is null when current is null");
  ok(!r.allVideos[1].likeBecameNull, "D4: v2 unaffected");
}

// --- D5: nextStateFrom keeps prev numeric value when current is null ---

console.log("\n--- D5: state retains prev number when scrape returns null ---");
{
  const prev: ChannelState = {
    channelId: "UCTEST1234567890ABCDEFG",
    channelTitle: "Test Channel",
    lastRun: "2026-05-06T09:00:00.000Z",
    subscriberCount: 1000,
    videos: {
      v1: { title: "Video One", likeCount: 10, commentCount: 2, viewCount: 100 },
    },
  };
  const blanked = snap({
    videos: [
      {
        videoId: "v1",
        title: "Video One",
        viewCount: 100,
        viewCountText: "100 views",
        likeCount: null,
        likeCountText: "",
        commentCount: null,
      },
    ],
  });
  const next = nextStateFrom(blanked, prev);
  eq(next.videos.v1.likeCount, 10, "D5: prev like (10) retained");
  eq(next.videos.v1.commentCount, 2, "D5: prev comment (2) retained");
}

// --- D6: state file round-trip (write + read + write again) ---

console.log("\n--- D6: state file persists and round-trips ---");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yt-state-"));
  try {
    const initial = nextStateFrom(snap(), null);
    saveState(tmp, initial);
    const loaded = loadState(tmp, initial.channelId);
    ok(loaded !== null, "D6: state loaded back");
    eq(loaded!.subscriberCount, 1000, "D6: subs persisted");
    eq(Object.keys(loaded!.videos).length, 2, "D6: videos persisted");

    // overwrite with new state
    const second = nextStateFrom(
      snap({ subscriberCount: 1100 }),
      loaded
    );
    saveState(tmp, second);
    const loaded2 = loadState(tmp, second.channelId);
    eq(loaded2!.subscriberCount, 1100, "D6: overwritten state has new sub count");

    // file should sit at the canonical path
    ok(
      fs.existsSync(stateFilePath(tmp, second.channelId)),
      "D6: state file at canonical path"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- D7: corrupt state file → loadState returns null (not crash) ---

console.log("\n--- D7: corrupt state file rebuilds baseline ---");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yt-state-"));
  try {
    const p = stateFilePath(tmp, "UCBAD123456789012345678");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ this is not json");
    const loaded = loadState(tmp, "UCBAD123456789012345678");
    eq(loaded, null, "D7: corrupt file → null (not throw)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- D8: report mirrors snapshot mode + warnings ---

console.log("\n--- D8: scrapeMode + warnings flow through to report ---");
{
  const r = computeReport(
    snap({ mode: "channel-only", warnings: ["everything is on fire"] }),
    null
  );
  eq(r.scrapeMode, "channel-only", "D8: scrapeMode mirrored");
  eq(r.warnings.length, 1, "D8: warnings carried through");
  eq(r.warnings[0], "everything is on fire", "D8: warning text intact");
}

console.log(`\n--- summary: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed === 0 ? 0 : 1);
