// invoked from Windows Task Scheduler via run-cron.bat. one shot, then exits.
// env: NOTIFY_CHAT_ID (req), NOTIFY_URL, YT_CHANNEL, YT_MAX_VIDEOS, YT_WORKSPACE.

import * as os from "node:os";
import * as path from "node:path";
import { runStatusReport } from "./check.js";
import { formatStatusReport } from "./format.js";
import { postToNotificationApi } from "./notify.js";

const channel = process.env.YT_CHANNEL ?? "UCA_NxRFfbYSG3kOeHak0BjQ";
// "all" / "0" → no limit
const maxVideosRaw = (process.env.YT_MAX_VIDEOS ?? "5").trim().toLowerCase();
const maxVideos =
  maxVideosRaw === "all" || maxVideosRaw === "0" ? 0 : parseInt(maxVideosRaw, 10);
const workspace =
  process.env.YT_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");

(async () => {
  const t0 = Date.now();
  console.log(
    `[cron-runner] start ${new Date().toISOString()}  channel=${channel} max=${maxVideos} workspace=${workspace}`
  );

  const report = await runStatusReport(channel, workspace, maxVideos);
  console.log(
    `[cron-runner] scrape: mode=${report.scrapeMode} firstRun=${report.isFirstRun} ` +
      `subs=${report.subscriberBefore ?? "—"}→${report.subscriberAfter ?? "—"} (Δ=${report.subscriberDelta ?? "—"}) ` +
      `changes=${report.videoChanges.length} videos=${report.allVideos.length} warnings=${report.warnings.length}`
  );

  const message = formatStatusReport(report);

  // bolt the 28-day analytics block onto the report when YT_ANALYTICS=true.
  // lazy import + try/catch on purpose: it pulls in OAuth and a different api,
  // and none of that is allowed to take down the core status post — worst case
  // we log and ship the report without the block.
  let finalMessage = message;
  if (process.env.YT_ANALYTICS === "true") {
    try {
      const { fetchAnalytics, formatAnalyticsBlock } = await import("./yt-analytics.js");
      const analytics = await fetchAnalytics();
      finalMessage = `${message}\n${formatAnalyticsBlock(analytics)}`;
      console.log(
        `[cron-runner] analytics: views28d=${analytics.views28d} ` +
          `watch=${analytics.watchTimeHours}h avgDur=${analytics.avgViewDurationSec}s ` +
          `subscribedShare=${analytics.subscribedShare ?? "—"}`
      );
    } catch (err) {
      console.error(
        `[cron-runner] analytics fetch failed (non-fatal):`,
        err instanceof Error ? err.message : err
      );
    }
  }
  console.log(`[cron-runner] formatted message (${finalMessage.length} chars)`);

  const result = await postToNotificationApi(finalMessage);
  console.log(
    `[cron-runner] posted: status=${result.status} body="${result.bodySnippet.slice(0, 100)}"`
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[cron-runner] done in ${elapsed}s`);
})().catch((err) => {
  console.error(
    `[cron-runner] FAILED:`,
    err instanceof Error ? err.stack ?? err.message : err
  );
  process.exit(1);
});
