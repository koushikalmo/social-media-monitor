import * as os from "node:os";
import * as path from "node:path";
import { scrapeChannel } from "./scrape.js";
import { runStatusReport } from "./check.js";

// usage:
//   node dist/cli.js <channel> [maxVideos]              one-shot snapshot, no state
//   node dist/cli.js --status <channel> [maxVideos]     periodic report, persists state
//   YT_WORKSPACE=/tmp/x node dist/cli.js --status ...   override state dir

const args = process.argv.slice(2);
const isStatus = args[0] === "--status";
const positional = isStatus ? args.slice(1) : args;
const channel = positional[0];
const maxVideos = positional[1] ? parseInt(positional[1], 10) : 5;

if (!channel) {
  console.error(
    "usage:\n" +
      "  node dist/cli.js <channel> [maxVideos]\n" +
      "  node dist/cli.js --status <channel> [maxVideos]"
  );
  process.exit(1);
}

const workspace =
  process.env.YT_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

function fmtDelta(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "±0";
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

async function snapshotMode(): Promise<void> {
  const snap = await scrapeChannel(channel, maxVideos);
  console.log(`\n=== ${snap.channelTitle} (${snap.channelId}) ===`);
  console.log(`scraped at: ${snap.scrapedAt}`);
  console.log(`mode: ${snap.mode}`);
  console.log(
    `subscribers: ${fmt(snap.subscriberCount)}  (${snap.subscriberCountText || "unknown"})`
  );
  console.log(`\nrecent videos (${snap.videos.length}):`);
  for (const v of snap.videos) {
    console.log(`  ${v.title}`);
    console.log(`    https://youtu.be/${v.videoId}`);
    console.log(
      `    views: ${fmt(v.viewCount)}, likes: ${fmt(v.likeCount)}, comments: ${fmt(v.commentCount)}`
    );
  }
  if (snap.warnings.length) {
    console.log(`\nwarnings:`);
    for (const w of snap.warnings) console.log(`  - ${w}`);
  }
}

async function statusMode(): Promise<void> {
  const r = await runStatusReport(channel, workspace, maxVideos);
  console.log(`\n=== ${r.channelTitle} (${r.channelId}) — status report ===`);
  console.log(`scraped at: ${r.scrapedAt}`);
  console.log(`scrape mode: ${r.scrapeMode}`);

  if (r.isFirstRun) {
    console.log(`first run — saving baseline. current numbers:`);
    console.log(`  subscribers: ${fmt(r.subscriberAfter)}`);
    for (const v of r.allVideos) {
      console.log(`  ${v.title}`);
      console.log(
        `    likes: ${fmt(v.likeAfter)}, comments: ${fmt(v.commentAfter)}, views: ${fmt(v.viewAfter)}`
      );
    }
  } else {
    console.log(
      `subscribers: ${fmt(r.subscriberBefore)} → ${fmt(r.subscriberAfter)}  (${fmtDelta(r.subscriberDelta)})`
    );
    if (r.videoChanges.length === 0) {
      console.log(`no per-video changes since last run`);
    } else {
      console.log(`\nchanges:`);
      for (const v of r.videoChanges) {
        console.log(`  ${v.title}`);
        console.log(
          `    likes ${fmtDelta(v.likeDelta)}  (${fmt(v.likeBefore)} → ${fmt(v.likeAfter)})`
        );
        console.log(
          `    comments ${fmtDelta(v.commentDelta)}  (${fmt(v.commentBefore)} → ${fmt(v.commentAfter)})`
        );
        console.log(
          `    views ${fmtDelta(v.viewDelta)}  (${fmt(v.viewBefore)} → ${fmt(v.viewAfter)})`
        );
      }
    }
  }

  if (r.warnings.length) {
    console.log(`\nwarnings:`);
    for (const w of r.warnings) console.log(`  - ${w}`);
  }
}

(async () => {
  if (isStatus) await statusMode();
  else await snapshotMode();
})().catch((err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
