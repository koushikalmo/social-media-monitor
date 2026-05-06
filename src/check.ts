import { scrapeChannel } from "./scrape.js";
import { loadState, saveState } from "./state.js";
import { computeReport, nextStateFrom, type StatusReport } from "./diff.js";

// orchestration: fetch snapshot, diff against stored state, persist new state.
// callers are the cron-driven plugin tool and the --status cli flag.
export async function runStatusReport(
  channelInput: string,
  workspace: string,
  maxVideos = 5
): Promise<StatusReport> {
  const snapshot = await scrapeChannel(channelInput, maxVideos);
  const prev = loadState(workspace, snapshot.channelId);
  const report = computeReport(snapshot, prev);
  saveState(workspace, nextStateFrom(snapshot, prev));
  return report;
}
