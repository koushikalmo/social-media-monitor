// end-to-end dry run. exercises the exact code path the cron will take, but
// stubs out the relay so we don't spam the real telegram group.
//
// run from project root after `npm run build`:
//   node dist/e2e-dryrun.js

import { runStatusReport } from "./check.js";
import { formatStatusReport } from "./format.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const CHANNEL = process.argv[2] ?? "@eagle3dstreaming";
const MAX_VIDEOS = parseInt(process.argv[3] ?? "3", 10);
const WORKSPACE = path.join(os.tmpdir(), `yt-e2e-${Date.now()}`);

// fast pacing for the test
process.env.YT_SCRAPE_INTER_DELAY_MS = "2000";
process.env.YT_SCRAPE_RETRY_MS = "10";
// pretend chat_id so notify.ts wouldn't throw if called (it won't be, we stub)
process.env.NOTIFY_CHAT_ID = "-9999999";

// stub the global fetch so any accidental POST to the relay is caught
const origFetch = globalThis.fetch;
let relayPosts = 0;
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = typeof input === "string" ? input : String(input);
  if (url.includes("notifications.eagle3dstreaming.com")) {
    relayPosts++;
    console.log(`  ❗ relay POST intercepted (this is the dry-run guard, real cron would actually post)`);
    return new Response('{"success":[{"message_id":1}]}', { status: 200 }) as unknown as Response;
  }
  return origFetch(input as RequestInfo, init);
}) as typeof globalThis.fetch;

console.log("============ end-to-end dry run ============");
console.log(`channel:    ${CHANNEL}`);
console.log(`maxVideos:  ${MAX_VIDEOS}`);
console.log(`workspace:  ${WORKSPACE}`);
console.log("");

async function runOnce(label: string): Promise<void> {
  console.log(`--- ${label} ---`);
  const t0 = Date.now();
  const report = await runStatusReport(CHANNEL, WORKSPACE, MAX_VIDEOS);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  scrape took ${elapsed}s; mode=${report.scrapeMode}; firstRun=${report.isFirstRun}`);
  console.log(`  subs ${report.subscriberBefore ?? "—"} → ${report.subscriberAfter ?? "—"} (delta=${report.subscriberDelta ?? "—"})`);
  console.log(`  videoChanges=${report.videoChanges.length}, allVideos=${report.allVideos.length}, warnings=${report.warnings.length}`);

  const formatted = formatStatusReport(report);
  console.log(`  formatted message (${formatted.length} chars):`);
  console.log("  ┌──");
  for (const line of formatted.split("\n")) {
    console.log(`  │ ${line}`);
  }
  console.log("  └──");
  console.log("");
}

try {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  await runOnce("STEP 1 — first run (baseline)");

  // mutate state to fake a change
  const stateFiles = fs.readdirSync(path.join(WORKSPACE, "youtube-state"));
  if (stateFiles.length > 0) {
    const statePath = path.join(WORKSPACE, "youtube-state", stateFiles[0]);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.subscriberCount !== null) {
      state.subscriberCount = state.subscriberCount - 50;
    }
    for (const v of Object.values(state.videos as Record<string, { likeCount: number | null; viewCount: number | null; commentCount: number | null }>)) {
      if (v.likeCount !== null) v.likeCount = Math.max(0, v.likeCount - 2);
      if (v.viewCount !== null) v.viewCount = Math.max(0, v.viewCount - 10);
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`(mutated state file to fake -50 subs / -2 likes / -10 views)\n`);
  }

  await runOnce("STEP 2 — second run (should report deltas)");

  // run again with no mutation — should show no-change message
  await runOnce("STEP 3 — third run (should report no changes)");

  console.log(`============ dry run complete ============`);
  console.log(`relay POSTs intercepted by stub: ${relayPosts}`);
  console.log(`workspace cleanup: ${WORKSPACE}`);
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
} catch (err) {
  console.error("\n❌ FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
}
