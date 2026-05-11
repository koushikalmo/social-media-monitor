// standalone direct-invocation runner. no openclaw, no llm, no agent.
// designed to be called from a system scheduler (Windows Task Scheduler /
// cron / launchd) every N hours. does scrape + diff + format + post in one
// deterministic pass, then exits.
//
// env vars:
//   NOTIFY_CHAT_ID   required (telegram chat id, e.g. "-5078640878")
//   NOTIFY_URL       optional (defaults to the eagle3dstreaming relay)
//   YT_CHANNEL       optional (default "UCA_NxRFfbYSG3kOeHak0BjQ")
//   YT_MAX_VIDEOS    optional (default 5)
//   YT_WORKSPACE     optional (default ~/.openclaw/workspace)
//
// run:
//   node dist/cron-runner.js

import * as os from "node:os";
import * as path from "node:path";
import { runStatusReport } from "./check.js";
import { formatStatusReport } from "./format.js";
import { postToNotificationApi } from "./notify.js";

const channel = process.env.YT_CHANNEL ?? "UCA_NxRFfbYSG3kOeHak0BjQ";
const maxVideos = parseInt(process.env.YT_MAX_VIDEOS ?? "5", 10);
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
  console.log(`[cron-runner] formatted message (${message.length} chars)`);

  const result = await postToNotificationApi(message);
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
