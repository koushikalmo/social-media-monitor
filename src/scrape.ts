// fetch + regex against ytInitialData. yt's markup shifts every few months,
// so every extractor has a fallback chain.

import { getExactSubscriberCount, type SubscriberSource } from "./yt-subscribers.js";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HTTP_TIMEOUT_MS = 20_000;

// read env at call time, not module load — tests override these via env vars
// after import (ESM imports hoist, so a static const would lock production
// defaults before the test setup line runs)
function interRequestDelayMs(): number {
  return parseInt(process.env.YT_SCRAPE_INTER_DELAY_MS ?? "60000", 10);
}
function retryAfter429Ms(): number {
  return parseInt(process.env.YT_SCRAPE_RETRY_MS ?? "6000", 10);
}
// ±25% randomization on top of the base delay; a metronome cadence is itself
// a bot signal
const INTER_REQUEST_JITTER_RATIO = 0.25;
// quit early once a couple of video fetches in a row fail; the IP is clearly toast
const CONSECUTIVE_FAIL_BAIL_THRESHOLD = 2;

// CONSENT/SOCS skips the EU consent gate; PREF=hl=en pins english locale
const COOKIE = "CONSENT=YES+; SOCS=CAI; PREF=hl=en";

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent": CHROME_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: COOKIE,
  "Sec-Ch-Ua": '"Chromium";v="120", "Not;A=Brand";v="24", "Google Chrome";v="120"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// returns the base delay ± jitter; clamped at zero. exported for pacing tests.
export function jitteredDelay(baseMs: number): number {
  if (baseMs <= 0) return 0;
  const range = baseMs * INTER_REQUEST_JITTER_RATIO * 2;
  const offset = Math.random() * range - range / 2;
  return Math.max(0, Math.round(baseMs + offset));
}

export type VideoSnapshot = {
  videoId: string;
  title: string;
  viewCount: number | null;
  viewCountText: string;
  likeCount: number | null;
  likeCountText: string;
  commentCount: number | null;
};

export type SnapshotMode = "full" | "partial" | "channel-only" | "views-only";

export type ChannelSnapshot = {
  channelId: string;
  channelTitle: string;
  subscriberCount: number | null;
  subscriberCountText: string;
  scrapedAt: string;
  mode: SnapshotMode;
  videos: VideoSnapshot[];
  warnings: string[];
};

// ---------- HTTP ----------

async function fetchOnce(url: string, referer?: string): Promise<Response> {
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (referer) {
    // looks like a click-through from the channel page rather than a cold scrape
    headers["Referer"] = referer;
    headers["Sec-Fetch-Site"] = "same-origin";
  } else {
    headers["Sec-Fetch-Site"] = "none";
  }
  headers["Sec-Fetch-Mode"] = "navigate";
  headers["Sec-Fetch-Dest"] = "document";
  return fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

async function fetchPage(url: string, referer?: string): Promise<string> {
  let res = await fetchOnce(url, referer);
  if (res.status === 429) {
    await sleep(retryAfter429Ms());
    res = await fetchOnce(url, referer);
  }
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
  }
  const html = await res.text();
  // tiny body + "sorry/index" or "captcha" = anti-bot interstitial. nothing we can do here.
  if (html.length < 5000 && /sorry\/index|captcha/i.test(html)) {
    throw new Error(
      `${url} returned anti-bot CAPTCHA — IP appears to be rate-limited. Wait a few minutes or run from a different host.`
    );
  }
  return html;
}

// ---------- Parsing helpers ----------

// pulls the ytInitialData json blob out of the page via brace-counting
function extractInitialData(html: string): unknown | null {
  const m = html.match(/(?:var\s+)?ytInitialData\s*=\s*\{/);
  if (!m) return null;
  const start = m.index! + m[0].length - 1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// "1.5K" / "12,345" / "1.2M views" → integer
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

// recursive-descent walker; lets extractors find renderers without hard-coded paths
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const obj = node as Record<string, unknown>;
  visit(obj);
  for (const k of Object.keys(obj)) walk(obj[k], visit);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// runs:[{text:"a"},{text:"b"}] → "ab", or simpleText if present
function readRuns(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const obj = node as Record<string, unknown>;
  if (typeof obj.simpleText === "string") return obj.simpleText;
  const runs = obj.runs;
  if (Array.isArray(runs)) {
    return runs.map((r) => asString((r as Record<string, unknown>).text)).join("");
  }
  return "";
}

// ---------- Channel ID resolution + page scrape ----------

export async function resolveChannelId(input: string): Promise<{ channelId: string; pageHtml: string }> {
  const trimmed = input.trim();
  let url: string;
  if (/^UC[\w-]{20,30}$/.test(trimmed)) {
    url = `https://www.youtube.com/channel/${trimmed}?hl=en&persist_hl=1`;
  } else {
    const handle = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    url = `https://www.youtube.com/${encodeURIComponent(handle)}?hl=en&persist_hl=1`;
  }
  const html = await fetchPage(url);
  // channelId / browseId / externalId all carry the same UC string
  const m = html.match(/"(?:channelId|browseId|externalId)":"(UC[\w-]{20,30})"/);
  if (!m) throw new Error(`couldn't extract channelId from ${url}`);
  return { channelId: m[1], pageHtml: html };
}

type RawVideo = {
  videoId: string;
  title: string;
  viewCountText: string;
  viewCount: number | null;
};

function extractVideosFromInitialData(data: unknown): RawVideo[] {
  const out: RawVideo[] = [];
  const seen = new Set<string>();

  // current shape: lockupViewModel. videoId in contentId, title nested in metadata.
  walk(data, (n) => {
    const lockup = n.lockupViewModel as Record<string, unknown> | undefined;
    if (!lockup || typeof lockup !== "object") return;
    if (lockup.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return;
    const videoId = asString(lockup.contentId);
    if (!videoId || seen.has(videoId)) return;

    const meta = lockup.metadata as Record<string, unknown> | undefined;
    const lmvm = meta?.lockupMetadataViewModel as Record<string, unknown> | undefined;
    const titleNode = lmvm?.title as Record<string, unknown> | undefined;
    const title = asString(titleNode?.content) || readRuns(titleNode);
    if (!title) return;

    let viewCountText = "";
    const innerMeta = lmvm?.metadata as Record<string, unknown> | undefined;
    const cmvm = innerMeta?.contentMetadataViewModel as Record<string, unknown> | undefined;
    const rows = cmvm?.metadataRows;
    if (Array.isArray(rows)) {
      outer: for (const row of rows) {
        const parts = (row as Record<string, unknown>)?.metadataParts;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
          const txt = asString(
            ((p as Record<string, unknown>).text as Record<string, unknown> | undefined)?.content
          );
          if (/view/i.test(txt)) {
            viewCountText = txt;
            break outer;
          }
        }
      }
    }

    seen.add(videoId);
    out.push({
      videoId,
      title,
      viewCountText,
      viewCount: parseFormattedNumber(viewCountText.replace(/views?/i, "")),
    });
  });

  // legacy renderers — still on some pages, and used by test fixtures.
  walk(data, (n) => {
    const videoId = asString(n.videoId);
    if (!videoId || seen.has(videoId)) return;
    const titleNode = (n.title ?? n.headline) as unknown;
    const title = readRuns(titleNode);
    if (!title) return;
    const viewNode =
      (n.viewCountText as unknown) ??
      (n.shortViewCountText as unknown) ??
      null;
    const viewCountText = readRuns(viewNode);
    seen.add(videoId);
    out.push({
      videoId,
      title,
      viewCountText,
      viewCount: parseFormattedNumber(viewCountText.replace(/views?/i, "")),
    });
  });

  return out;
}

function extractChannelTitle(html: string, data: unknown): string {
  const m = html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/);
  if (m) return m[1];
  // fallback: walk the parsed json in case the regex misses
  let title = "";
  walk(data, (n) => {
    if (title) return;
    const t = n.channelMetadataRenderer as Record<string, unknown> | undefined;
    if (t && typeof t.title === "string") title = t.title;
  });
  return title;
}

function extractSubscriberInfo(html: string): { count: number | null; text: string } {
  // ordered by how current the markup is — most recent shape first
  const candidates = [
    /"content":"([0-9.,]+\s*[KMB]?\s*subscribers?)"/i,
    /"subscriberCountText":\{[^}]*"(?:simpleText|content)":"([^"]+)"/,
    /"([0-9.,]+\s*[KMB]?\s*subscribers?)"/i,
    /([0-9.,]+\s*[KMB]?\s*subscribers?)/,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m) {
      const text = m[1];
      const numericPart = text.replace(/subscribers?/i, "").trim();
      return { count: parseFormattedNumber(numericPart), text };
    }
  }
  return { count: null, text: "" };
}

// ---------- Video page scrape ----------

async function scrapeVideoPage(
  videoId: string,
  referer: string
): Promise<{
  title: string;
  viewCount: number | null;
  viewCountText: string;
  likeCount: number | null;
  likeCountText: string;
  commentCount: number | null;
  commentsDisabled: boolean;
}> {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const html = await fetchPage(url, referer);
  const data = extractInitialData(html);

  let title = "";
  let viewCount: number | null = null;
  let viewCountText = "";

  walk(data, (n) => {
    if (title) return;
    const r = n.videoPrimaryInfoRenderer as Record<string, unknown> | undefined;
    if (!r) return;
    title = readRuns(r.title);
    const vc = r.viewCount as Record<string, unknown> | undefined;
    const vcr = (vc?.videoViewCountRenderer as Record<string, unknown> | undefined)?.viewCount;
    viewCountText = readRuns(vcr);
    viewCount = parseFormattedNumber(viewCountText.replace(/views?/i, ""));
  });

  // ordered roughly oldest-stable → newest-shape. the accessibility label
  // matches "12 likes" / "1.2K likes" and is the most enduring; the others
  // catch newer factoid/segmented-button shapes.
  let likeCount: number | null = null;
  let likeCountText = "";
  const likeMatchers = [
    // current as of 2026-05: like-button uses buttonViewModel with iconName:LIKE
    // and the count in title. anonymous pages show this shape directly.
    /"buttonViewModel":\{"iconName":"LIKE","title":"([0-9.,]+[KMB]?)"/i,
    /"accessibilityData":\{"label":"([0-9.,]+[KMB]?)\s*likes?"\}/i,
    /"defaultText":\{"simpleText":"([0-9.,]+[KMB]?)\s*likes?"/i,
    /"label":"([0-9.,]+[KMB]?)\s*likes?"/i,
    /"likeButton[^}]+?"defaultText":\{[^}]*?"simpleText":"([0-9.,]+[KMB]?)"/,
    /"toggledText":\{[^}]*?"simpleText":"([0-9.,]+[KMB]?)\s*likes?"/i,
    // older segmentedLikeDislikeButtonViewModel shape
    /"segmentedLikeDislikeButtonViewModel"[^]*?"likeCount(?:WithCount)?":\{[^}]*?"(?:simpleText|content)":"([0-9.,]+[KMB]?)"/i,
    // factoid card style sometimes shown above comments
    /"factoidViewModel":\{[^}]*?"value":\{[^}]*?"content":"([0-9.,]+[KMB]?)"\}[^}]*?"label":\{[^}]*?"content":"likes?"/i,
    // dedicated count fields (older but still shipped on some videos)
    /"likeCountText":\{[^}]*?"simpleText":"([0-9.,]+[KMB]?)/i,
    /"likeCount":"([0-9]+)"/,
    // accessibility variants — "X people liked this video", "like this video along with X other people"
    /"label":"([0-9,]+)\s*people\s*(?:liked|like)\s*this/i,
    /"label":"like this video along with ([0-9,]+)\s*other\s*people/i,
  ];
  for (const re of likeMatchers) {
    const m = html.match(re);
    if (m) {
      likeCountText = m[0];
      likeCount = parseFormattedNumber(m[1]);
      break;
    }
  }

  let commentCount: number | null = null;
  const commentMatchers = [
    /"commentCount":\{"simpleText":"([0-9.,]+)"/,
    /"commentCount":\{"runs":\[\{"text":"([0-9.,]+)"/,
    /"commentsCount":\{"simpleText":"([0-9.,]+)"/,
    /"commentsEntryPointHeaderRenderer"[^]*?"commentCount":\{[^}]*?"simpleText":"([0-9.,]+)"/,
    /"contextualInfo":\{"runs":\[\{"text":"([0-9.,]+)"\}\][^}]*?\}[^}]*?Comments?/,
    /"([0-9.,]+)\s*Comments?"/,
  ];
  for (const re of commentMatchers) {
    const m = html.match(re);
    if (m) {
      commentCount = parseFormattedNumber(m[1]);
      break;
    }
  }

  // detect uploader-disabled comments — distinct from a parser miss. yt
  // ships strings like "Comments are turned off" on the disabled-card.
  const commentsDisabled = /Comments are turned off/i.test(html);

  return { title, viewCount, viewCountText, likeCount, likeCountText, commentCount, commentsDisabled };
}

// ---------- Continuation / pagination ----------

type InnertubeConfig = {
  apiKey: string;
  context: { client: { clientName: string; clientVersion: string; hl: string; gl: string } };
};

function extractInnertubeConfig(html: string): InnertubeConfig | null {
  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!keyMatch) return null;
  const versionMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  const nameMatch = html.match(/"INNERTUBE_CLIENT_NAME":"([^"]+)"/);
  return {
    apiKey: keyMatch[1],
    context: {
      client: {
        clientName: nameMatch?.[1] ?? "WEB",
        clientVersion: versionMatch?.[1] ?? "2.20260101.00.00",
        hl: "en",
        gl: "US",
      },
    },
  };
}

function extractContinuationToken(data: unknown): string | null {
  let token: string | null = null;
  walk(data, (n) => {
    if (token) return;
    const cir = n.continuationItemRenderer as Record<string, unknown> | undefined;
    if (!cir) return;
    const endpoint = cir.continuationEndpoint as Record<string, unknown> | undefined;
    const cmd = endpoint?.continuationCommand as Record<string, unknown> | undefined;
    if (typeof cmd?.token === "string") token = cmd.token;
  });
  return token;
}

async function fetchContinuation(
  token: string,
  cfg: InnertubeConfig,
  referer: string
): Promise<unknown> {
  const url = `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(cfg.apiKey)}`;
  const body = JSON.stringify({ context: cfg.context, continuation: token });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://www.youtube.com",
      Referer: referer,
      "User-Agent": CHROME_UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`continuation HTTP ${res.status}`);
  return res.json();
}

// ---------- Top-level orchestration ----------

export async function scrapeChannel(
  channelInput: string,
  maxVideos = 5
): Promise<ChannelSnapshot> {
  const warnings: string[] = [];
  const { channelId, pageHtml } = await resolveChannelId(channelInput);
  const homeData = extractInitialData(pageHtml);

  const channelTitle = extractChannelTitle(pageHtml, homeData) || channelId;
  let subInfo = extractSubscriberInfo(pageHtml);
  if (subInfo.count === null) {
    warnings.push("subscriber count not found in channel page markup");
  }

  // override the rounded HTML count with an exact value when the env opts in
  const rawSubSource = (process.env.YT_SUBSCRIBER_SOURCE ?? "").toLowerCase();
  const subSource: SubscriberSource | null =
    rawSubSource === "mixerno"
      ? "mixerno"
      : rawSubSource === "livecounts"
        ? "livecounts"
        : null;
  if (subSource) {
    const lookup = await getExactSubscriberCount(channelId, subSource);
    if (lookup.count !== null) {
      subInfo = {
        count: lookup.count,
        text: `${lookup.count.toLocaleString()} subscribers`,
      };
    } else {
      warnings.unshift(
        `subscriber lookup rate-limited — using rounded YouTube count this run (${(lookup.error ?? "").slice(0, 80)})`
      );
    }
  }

  // /videos tab is channel-only; home page mixes in featured carousels.
  let videoListData: unknown = homeData;
  let videoListHtml: string = pageHtml;
  try {
    const videosUrl = `https://www.youtube.com/channel/${channelId}/videos?hl=en`;
    const fetched = await fetchPage(
      videosUrl,
      `https://www.youtube.com/channel/${channelId}`
    );
    videoListData = extractInitialData(fetched);
    videoListHtml = fetched;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(
      `/videos tab fetch failed (${msg}) — falling back to channel home page for video list`
    );
  }

  // initial /videos render ships ~30 videos; follow continuation tokens for the rest.
  const collected: RawVideo[] = extractVideosFromInitialData(videoListData);
  const seenIds = new Set(collected.map((v) => v.videoId));
  const cfg = extractInnertubeConfig(videoListHtml);
  let continuation = extractContinuationToken(videoListData);
  let pageCount = 0;
  const MAX_PAGES = 60;
  while (
    cfg &&
    continuation &&
    pageCount < MAX_PAGES &&
    (maxVideos <= 0 || collected.length < maxVideos)
  ) {
    try {
      await sleep(jitteredDelay(1500));
      const next = await fetchContinuation(
        continuation,
        cfg,
        `https://www.youtube.com/channel/${channelId}/videos`
      );
      const moreVideos = extractVideosFromInitialData(next);
      let added = 0;
      for (const v of moreVideos) {
        if (!seenIds.has(v.videoId)) {
          collected.push(v);
          seenIds.add(v.videoId);
          added++;
        }
      }
      continuation = extractContinuationToken(next);
      pageCount++;
      if (added === 0) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`pagination stopped at page ${pageCount + 1}: ${msg}`);
      break;
    }
  }

  // maxVideos <= 0 → no limit
  const rawVideos = maxVideos > 0 ? collected.slice(0, maxVideos) : collected;
  if (rawVideos.length === 0) {
    warnings.push("no videos found on channel page — possibly empty channel or markup change");
  }

  const viewsOnly = (process.env.YT_VIEWS_ONLY ?? "").toLowerCase() === "true";

  // sequential with delay + referer; bursts and cold scrapes are the easy bot signals
  const refererUrl = `https://www.youtube.com/channel/${channelId}`;
  const videoResults: VideoSnapshot[] = [];
  const perVideoFailures: string[] = [];
  let consecutiveFailures = 0;
  let earlyBailReason: string | null = null;

  if (viewsOnly) {
    // /videos tab already exposes exact view counts; skip per-video pages.
    for (const rv of rawVideos) {
      videoResults.push({
        videoId: rv.videoId,
        title: rv.title,
        viewCount: rv.viewCount,
        viewCountText: rv.viewCountText,
        likeCount: null,
        likeCountText: "",
        commentCount: null,
      });
    }
  } else {
    for (let i = 0; i < rawVideos.length; i++) {
    const rv = rawVideos[i];

    // already bailed → stub the rest with channel-page data only
    if (earlyBailReason) {
      videoResults.push(emptyVideoFromRaw(rv));
      continue;
    }

    if (i > 0) await sleep(jitteredDelay(interRequestDelayMs()));

    try {
      const v = await scrapeVideoPage(rv.videoId, refererUrl);
      // page fetched OK but the parser came up empty? probably a markup
      // shift — surface so the operator can investigate. don't warn when the
      // uploader explicitly disabled comments (a null is the right answer).
      if (v.viewCount !== null && v.likeCount === null) {
        warnings.push(
          `video ${rv.videoId}: page fetched but no like-count pattern matched — markup may have changed (see likeMatchers in src/scrape.ts)`
        );
      }
      if (v.viewCount !== null && v.commentCount === null && !v.commentsDisabled) {
        warnings.push(
          `video ${rv.videoId}: page fetched but no comment-count pattern matched — markup may have changed (see commentMatchers in src/scrape.ts)`
        );
      }
      videoResults.push({
        videoId: rv.videoId,
        title: v.title || rv.title,
        viewCount: v.viewCount ?? rv.viewCount,
        viewCountText: v.viewCountText || rv.viewCountText,
        likeCount: v.likeCount,
        likeCountText: v.likeCountText,
        commentCount: v.commentCount,
      });
      consecutiveFailures = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      perVideoFailures.push(`${rv.videoId}: ${msg}`);
      videoResults.push(emptyVideoFromRaw(rv));
      consecutiveFailures++;

      // captcha = whole IP is gated; a couple of 429s in a row = same effective state
      if (/captcha|sorry\/index/i.test(msg)) {
        earlyBailReason = "anti-bot CAPTCHA detected";
      } else if (consecutiveFailures >= CONSECUTIVE_FAIL_BAIL_THRESHOLD) {
        earlyBailReason = `${consecutiveFailures} consecutive video-page failures`;
      }
    }
    }
  }

  let mode: SnapshotMode;
  if (viewsOnly) {
    mode = videoResults.length > 0 ? "views-only" : "channel-only";
  } else {
    const failedCount = videoResults.filter(
      (v) => v.likeCount === null && v.commentCount === null
    ).length;
    if (failedCount === 0) {
      mode = "full";
    } else if (failedCount === videoResults.length && videoResults.length > 0) {
      mode = "channel-only";
    } else {
      mode = "partial";
    }
  }

  // collapse N near-identical "video X failed" lines into one summary when
  // the whole batch is dead; partial mode keeps the per-video lines because
  // they're useful for figuring out which video misbehaved.
  if (mode === "channel-only" && perVideoFailures.length > 0) {
    warnings.push(
      `video-page scraping blocked (${earlyBailReason ?? "all videos failed"}) — showing channel-page data only. like and comment counts are not available this run; try again later.`
    );
  } else {
    for (const f of perVideoFailures) {
      warnings.push(`couldn't scrape video ${f}`);
    }
    if (earlyBailReason && mode === "partial") {
      warnings.push(`stopped early after ${earlyBailReason}`);
    }
  }

  return {
    channelId,
    channelTitle,
    subscriberCount: subInfo.count,
    subscriberCountText: subInfo.text,
    scrapedAt: new Date().toISOString(),
    mode,
    videos: videoResults,
    warnings,
  };
}

function emptyVideoFromRaw(rv: RawVideo): VideoSnapshot {
  return {
    videoId: rv.videoId,
    title: rv.title,
    viewCount: rv.viewCount,
    viewCountText: rv.viewCountText,
    likeCount: null,
    likeCountText: "",
    commentCount: null,
  };
}
