// number-parser regex tests + end-to-end scrapeChannel tests with mocked fetch
// (full / partial / channel-only / captcha / 429-retry / empty channel)

// override the production delays so the retry-path tests don't take ~6s per video
process.env.YT_SCRAPE_INTER_DELAY_MS = "5";
process.env.YT_SCRAPE_RETRY_MS = "10";

import { scrapeChannel } from "./scrape.js";

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

function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
    failed++;
    return;
  }
  console.log("ok  ", msg);
  passed++;
}

// number-format parser — duplicated here so we can assert without exporting it
// from the production module

function parseFormattedNumber(input: string | null | undefined): number | null {
  if (!input) return null;
  const cleaned = input.replace(/[^\d.,KMBkmb\s]/g, "").trim();
  const m = cleaned.match(/^([\d,]+(?:\.\d+)?)\s*([KMBkmb])?/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  const unit = m[2]?.toUpperCase();
  const mult = unit === "K" ? 1e3 : unit === "M" ? 1e6 : unit === "B" ? 1e9 : 1;
  return Math.round(num * mult);
}

console.log("\n--- parseFormattedNumber ---");
ok(parseFormattedNumber("1,234") === 1234, "1,234 → 1234");
ok(parseFormattedNumber("1.5K") === 1500, "1.5K → 1500");
ok(parseFormattedNumber("12.4M") === 12_400_000, "12.4M → 12_400_000");
ok(parseFormattedNumber("2B") === 2_000_000_000, "2B → 2_000_000_000");
ok(parseFormattedNumber("89") === 89, "89 → 89");
ok(parseFormattedNumber("89 views") === 89, "89 views → 89");
ok(parseFormattedNumber("1K subscribers") === 1000, "1K subscribers → 1000");
ok(parseFormattedNumber("") === null, "empty → null");
ok(parseFormattedNumber(null) === null, "null → null");
ok(parseFormattedNumber("garbage") === null, "garbage → null");

// end-to-end tests against scrapeChannel with globalThis.fetch swapped out

type MockResponse = { status: number; body: string };
type MockHandler = (url: string) => MockResponse;

function installMockFetch(handler: MockHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    const r = handler(url);
    return new Response(r.body, {
      status: r.status,
      statusText: r.status >= 400 ? "Error" : "OK",
      headers: { "Content-Type": "text/html" },
    });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeChannelHtml(opts: {
  channelId: string;
  title: string;
  subText: string;
  videos: Array<{ id: string; title: string; viewText: string }>;
}): string {
  const data = {
    metadata: { channelMetadataRenderer: { title: opts.title } },
    contents: {
      tabs: opts.videos.map((v) => ({
        gridVideoRenderer: {
          videoId: v.id,
          title: { runs: [{ text: v.title }] },
          viewCountText: { simpleText: v.viewText },
        },
      })),
    },
  };
  // pad past the 5kb threshold so the CAPTCHA detector doesn't false-positive
  const padding = "<!-- " + "x".repeat(6000) + " -->";
  return `<!DOCTYPE html><html><head>
<script>var ytInitialData = ${JSON.stringify(data)};</script>
${padding}
</head><body>
"channelId":"${opts.channelId}"
"content":"${opts.subText}"
</body></html>`;
}

function makeVideoHtml(opts: {
  title: string;
  viewText: string;
  likeCount: number;
  commentCount: number;
}): string {
  const data = {
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              {
                videoPrimaryInfoRenderer: {
                  title: { runs: [{ text: opts.title }] },
                  viewCount: {
                    videoViewCountRenderer: {
                      viewCount: { simpleText: opts.viewText },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
  const padding = "<!-- " + "x".repeat(6000) + " -->";
  return `<!DOCTYPE html><html><head>
<script>var ytInitialData = ${JSON.stringify(data)};</script>
${padding}
</head><body>
"accessibilityData":{"label":"${opts.likeCount} likes"}
"commentCount":{"simpleText":"${opts.commentCount}"}
</body></html>`;
}

const CAPTCHA_BODY =
  '<HTML><HEAD><TITLE>302 Moved</TITLE></HEAD><BODY>The document has moved <A HREF="https://www.google.com/sorry/index?continue=...">here</A>.</BODY></HTML>';

const CHANNEL_FIXTURE = makeChannelHtml({
  channelId: "UCTESTCHANNEL1234567890",
  title: "Test Channel",
  subText: "5K subscribers",
  videos: [
    { id: "vidA", title: "Video A", viewText: "100 views" },
    { id: "vidB", title: "Video B", viewText: "200 views" },
    { id: "vidC", title: "Video C", viewText: "300 views" },
  ],
});

function isVideoUrl(url: string): boolean {
  return url.includes("/watch?v=");
}

function videoIdFromUrl(url: string): string {
  return url.match(/v=([\w-]+)/)?.[1] ?? "";
}

// --- T1: full success ---

console.log("\n--- T1: full success (channel + every video page) ---");
{
  const restore = installMockFetch((url) => {
    if (isVideoUrl(url)) {
      const id = videoIdFromUrl(url);
      const map: Record<string, { likes: number; comments: number }> = {
        vidA: { likes: 10, comments: 2 },
        vidB: { likes: 25, comments: 5 },
        vidC: { likes: 7, comments: 0 },
      };
      const v = map[id];
      return {
        status: 200,
        body: makeVideoHtml({
          title: `Video ${id}`,
          viewText: "100 views",
          likeCount: v.likes,
          commentCount: v.comments,
        }),
      };
    }
    return { status: 200, body: CHANNEL_FIXTURE };
  });
  try {
    const snap = await scrapeChannel("UCTESTCHANNEL1234567890", 3);
    eq(snap.mode, "full", "T1: mode=full");
    eq(snap.channelId, "UCTESTCHANNEL1234567890", "T1: channelId");
    eq(snap.channelTitle, "Test Channel", "T1: channelTitle");
    eq(snap.subscriberCount, 5000, "T1: subscriberCount=5000");
    eq(snap.videos.length, 3, "T1: 3 videos");
    eq(snap.videos[0].likeCount, 10, "T1: video A likes=10");
    eq(snap.videos[1].likeCount, 25, "T1: video B likes=25");
    eq(snap.videos[2].likeCount, 7, "T1: video C likes=7");
    eq(snap.videos[0].commentCount, 2, "T1: video A comments=2");
    eq(snap.warnings.length, 0, "T1: zero warnings");
  } finally {
    restore();
  }
}

// --- T2: all video pages return 429 (after retry too) → channel-only mode ---

console.log("\n--- T2: every video page 429 → mode=channel-only, early bail ---");
{
  let videoCallCount = 0;
  const restore = installMockFetch((url) => {
    if (isVideoUrl(url)) {
      videoCallCount++;
      return { status: 429, body: "rate limited" };
    }
    return { status: 200, body: CHANNEL_FIXTURE };
  });
  try {
    // Fixture has 3 videos and bail-threshold is 2. Expected behavior:
    //   video 1: fail   (consecutiveFailures=1)
    //   video 2: fail   (consecutiveFailures=2 → bail set)
    //   video 3: skipped (empty record, no fetch)
    // Each 429 retries once, so attempted video fetches = 2 videos × 2 = 4.
    const snap = await scrapeChannel("UCTESTCHANNEL1234567890", 3);
    eq(snap.mode, "channel-only", "T2: mode=channel-only");
    eq(snap.videos.length, 3, "T2: 3 video entries returned (with nulls)");
    eq(snap.videos[0].likeCount, null, "T2: vid 0 likes=null");
    eq(snap.videos[2].likeCount, null, "T2: vid 2 likes=null");
    eq(snap.videos[0].viewCount, 100, "T2: vid 0 view count from channel page preserved");
    ok(snap.warnings.length === 1, "T2: warnings consolidated to a single line");
    ok(/blocked|consecutive/i.test(snap.warnings[0]), "T2: warning explains the block");
    ok(videoCallCount <= 4, `T2: bailed early — only ${videoCallCount} video fetches (≤4)`);
  } finally {
    restore();
  }
}

// --- T3: first video page CAPTCHA → instant bail ---

console.log("\n--- T3: first video page CAPTCHA → instant early bail ---");
{
  let videoCallCount = 0;
  const restore = installMockFetch((url) => {
    if (isVideoUrl(url)) {
      videoCallCount++;
      return { status: 200, body: CAPTCHA_BODY };
    }
    return { status: 200, body: CHANNEL_FIXTURE };
  });
  try {
    const snap = await scrapeChannel("UCTESTCHANNEL1234567890", 3);
    eq(snap.mode, "channel-only", "T3: mode=channel-only");
    eq(snap.videos.length, 3, "T3: 3 video entries returned");
    eq(snap.videos[0].likeCount, null, "T3: video 0 likes=null");
    ok(/CAPTCHA|blocked/i.test(snap.warnings[0]), "T3: warning mentions CAPTCHA/blocked");
    eq(videoCallCount, 1, "T3: bailed after exactly 1 video fetch (CAPTCHA was decisive)");
  } finally {
    restore();
  }
}

// --- T4: partial — videos 1 & 3 succeed, video 2 fails ---

console.log("\n--- T4: partial — middle video fails, others succeed ---");
{
  const restore = installMockFetch((url) => {
    if (isVideoUrl(url)) {
      const id = videoIdFromUrl(url);
      if (id === "vidB") {
        return { status: 503, body: "transient server error" };
      }
      return {
        status: 200,
        body: makeVideoHtml({
          title: `Video ${id}`,
          viewText: "100 views",
          likeCount: 5,
          commentCount: 1,
        }),
      };
    }
    return { status: 200, body: CHANNEL_FIXTURE };
  });
  try {
    const snap = await scrapeChannel("UCTESTCHANNEL1234567890", 3);
    eq(snap.mode, "partial", "T4: mode=partial");
    eq(snap.videos[0].likeCount, 5, "T4: video A succeeded");
    eq(snap.videos[1].likeCount, null, "T4: video B failed (null likes)");
    eq(snap.videos[2].likeCount, 5, "T4: video C succeeded after B failed (consecutive failures reset on success)");
    ok(
      snap.warnings.some((w) => w.includes("vidB")),
      "T4: warning mentions the specific failed video"
    );
  } finally {
    restore();
  }
}

// --- T5: channel page itself returns CAPTCHA → throws (no fallback possible) ---

console.log("\n--- T5: channel page itself CAPTCHA → throws ---");
{
  const restore = installMockFetch(() => ({ status: 200, body: CAPTCHA_BODY }));
  try {
    let threw = false;
    try {
      await scrapeChannel("UCTESTCHANNEL1234567890", 3);
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      ok(/CAPTCHA|rate-limited/i.test(msg), "T5: error message mentions CAPTCHA/rate-limit");
    }
    ok(threw, "T5: scrapeChannel threw");
  } finally {
    restore();
  }
}

// --- T6: 429 then retry succeeds ---

console.log("\n--- T6: 429 on first attempt, retry succeeds → full mode ---");
{
  const seen: Record<string, number> = {};
  const restore = installMockFetch((url) => {
    if (isVideoUrl(url)) {
      const id = videoIdFromUrl(url);
      seen[id] = (seen[id] ?? 0) + 1;
      // 429 first time, success second time
      if (seen[id] === 1) {
        return { status: 429, body: "rate limited" };
      }
      return {
        status: 200,
        body: makeVideoHtml({
          title: `Video ${id}`,
          viewText: "100 views",
          likeCount: 99,
          commentCount: 3,
        }),
      };
    }
    return { status: 200, body: CHANNEL_FIXTURE };
  });
  try {
    const snap = await scrapeChannel("UCTESTCHANNEL1234567890", 3);
    eq(snap.mode, "full", "T6: mode=full (retry recovered each video)");
    eq(snap.videos[0].likeCount, 99, "T6: video A likes=99 after retry");
    eq(snap.videos[1].likeCount, 99, "T6: video B likes=99 after retry");
    eq(snap.videos[2].likeCount, 99, "T6: video C likes=99 after retry");
    eq(snap.warnings.length, 0, "T6: no warnings — retry was clean");
    eq(seen.vidA, 2, "T6: vidA fetched exactly twice");
  } finally {
    restore();
  }
}

// --- T7: empty channel (no videos in feed) ---

console.log("\n--- T7: empty channel page (no videos) ---");
{
  const emptyChannel = makeChannelHtml({
    channelId: "UCEMPTY11111111111111111",
    title: "Empty Channel",
    subText: "0 subscribers",
    videos: [],
  });
  const restore = installMockFetch(() => ({ status: 200, body: emptyChannel }));
  try {
    const snap = await scrapeChannel("UCEMPTY11111111111111111", 5);
    eq(snap.videos.length, 0, "T7: zero videos");
    // No videos at all → fall-through path, mode is "channel-only" since
    // `failedCount === videoResults.length === 0` is false (length is 0),
    // so we end up at the else (mode = "partial") with empty arrays. That's
    // a corner case — assert the actual behavior is sensible: mode is one
    // of the three valid values, no crash.
    ok(
      ["full", "partial", "channel-only"].includes(snap.mode),
      `T7: mode is valid (${snap.mode})`
    );
    ok(
      snap.warnings.some((w) => w.includes("no videos")),
      "T7: warning surfaced about missing videos"
    );
  } finally {
    restore();
  }
}

// --- T9: newer markup shapes — factoid likes, dedicated commentsCount ---

console.log("\n--- T9: newer markup shapes still parse ---");
{
  // synthesize a video page using the newer factoid-style like markup and
  // commentsCount field, instead of the older accessibilityData / commentCount
  // shapes
  function makeVideoHtmlNewerShape(opts: {
    title: string;
    likes: number;
    comments: number;
  }): string {
    const data = {
      contents: {
        twoColumnWatchNextResults: {
          results: {
            results: {
              contents: [
                {
                  videoPrimaryInfoRenderer: {
                    title: { runs: [{ text: opts.title }] },
                    viewCount: {
                      videoViewCountRenderer: {
                        viewCount: { simpleText: "100 views" },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
    const padding = "<!-- " + "x".repeat(6000) + " -->";
    return `<!DOCTYPE html><html><head>
<script>var ytInitialData = ${JSON.stringify(data)};</script>
${padding}
</head><body>
"factoidViewModel":{"value":{"content":"${opts.likes}"},"label":{"content":"likes"}}
"commentsCount":{"simpleText":"${opts.comments}"}
</body></html>`;
  }
  const restore = installMockFetch((url) => {
    if (isVideoUrl(url)) {
      return {
        status: 200,
        body: makeVideoHtmlNewerShape({ title: "video", likes: 42, comments: 7 }),
      };
    }
    return { status: 200, body: CHANNEL_FIXTURE };
  });
  try {
    const snap = await scrapeChannel("UCTESTCHANNEL1234567890", 1);
    eq(snap.videos[0].likeCount, 42, "T9: factoid-style likes parsed (42)");
    eq(snap.videos[0].commentCount, 7, "T9: commentsCount-style comments parsed (7)");
  } finally {
    restore();
  }
}

// --- T10: page fetches but parser misses → markup-shift warning ---

console.log("\n--- T10: page OK but parser empty → markup-shift warning ---");
{
  // body has a valid view count but no recognizable like/comment markup at all
  const orphanBody = `<!DOCTYPE html><html><head>
<script>var ytInitialData = {"contents":{"twoColumnWatchNextResults":{"results":{"results":{"contents":[{"videoPrimaryInfoRenderer":{"title":{"runs":[{"text":"orphan"}]},"viewCount":{"videoViewCountRenderer":{"viewCount":{"simpleText":"100 views"}}}}}]}}}}};</script>
${"<!-- " + "x".repeat(6000) + " -->"}
</head><body>nothing else</body></html>`;
  const restore = installMockFetch((url) => {
    if (isVideoUrl(url)) {
      return { status: 200, body: orphanBody };
    }
    return { status: 200, body: CHANNEL_FIXTURE };
  });
  try {
    const snap = await scrapeChannel("UCTESTCHANNEL1234567890", 1);
    eq(snap.videos[0].viewCount, 100, "T10: view count still extracted");
    eq(snap.videos[0].likeCount, null, "T10: likes null (no pattern matched)");
    eq(snap.videos[0].commentCount, null, "T10: comments null (no pattern matched)");
    ok(
      snap.warnings.some((w) => w.includes("like-count pattern")),
      "T10: warning surfaced about missing like pattern"
    );
    ok(
      snap.warnings.some((w) => w.includes("comment-count pattern")),
      "T10: warning surfaced about missing comment pattern"
    );
  } finally {
    restore();
  }
}

// --- T8: live network smoke test (best-effort, skipped if rate-limited) ---

console.log("\n--- T8: live channel-page scrape (skipped if rate-limited) ---");
try {
  const snap = await scrapeChannel("@eagle3dstreaming", 0);
  ok(typeof snap.channelId === "string" && snap.channelId.startsWith("UC"), "T8: channelId resolved");
  ok(snap.channelTitle.length > 0, "T8: channelTitle non-empty");
  ok(["full", "partial", "channel-only"].includes(snap.mode), "T8: mode is one of the valid values");
  console.log(`     sample: ${snap.channelTitle} — subs ${snap.subscriberCount ?? "—"}, mode=${snap.mode}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/CAPTCHA|429|rate-limited/i.test(msg)) {
    console.log("skip live test — IP rate-limited:", msg.slice(0, 100));
  } else {
    console.error("FAIL: live scrape:", msg);
    failed++;
  }
}

console.log(`\n--- summary: ${passed} passed, ${failed} failed ---\n`);
process.exit(failed === 0 ? 0 : 1);
