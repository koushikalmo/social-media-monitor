import { scrapeChannel } from "./scrape.js";

const channel = process.argv[2];
const maxVideosArg = process.argv[3];
const maxVideos = maxVideosArg ? parseInt(maxVideosArg, 10) : 5;

if (!channel) {
  console.error("usage: node dist/cli.js <UC...|@handle> [maxVideos]");
  process.exit(1);
}

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

(async () => {
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
})().catch((err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
