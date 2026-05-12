import type { StatusReport, VideoDelta } from "./diff.js";

// renders a StatusReport into the plain-text body the relay forwards to Telegram.

function fmtNum(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

function fmtDelta(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "±0";
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

function videoDeltaLines(v: VideoDelta): string[] {
  const out: string[] = [`• ${v.title}`];
  if (v.likeDelta !== null && v.likeDelta !== 0) {
    out.push(`  likes: ${fmtNum(v.likeBefore)} → ${fmtNum(v.likeAfter)} (${fmtDelta(v.likeDelta)})`);
  }
  if (v.commentDelta !== null && v.commentDelta !== 0) {
    out.push(`  comments: ${fmtNum(v.commentBefore)} → ${fmtNum(v.commentAfter)} (${fmtDelta(v.commentDelta)})`);
  }
  if (v.viewDelta !== null && v.viewDelta !== 0) {
    out.push(`  views: ${fmtNum(v.viewBefore)} → ${fmtNum(v.viewAfter)} (${fmtDelta(v.viewDelta)})`);
  }
  return out;
}

export function formatStatusReport(r: StatusReport): string {
  const lines: string[] = [];

  if (r.isFirstRun) {
    lines.push(`📺 ${r.channelTitle} — initial baseline`);
    lines.push("");
    lines.push(`Subscribers: ${fmtNum(r.subscriberAfter)}`);
    if (r.allVideos.length > 0) {
      lines.push("");
      lines.push(`Tracking ${r.allVideos.length} recent videos:`);
      // telegram caps messages at 4096 chars; 15 videos × ~180 char/video fits.
      const MAX_BASELINE_VIDEOS = 15;
      const shown = r.allVideos.slice(0, MAX_BASELINE_VIDEOS);
      for (const v of shown) {
        lines.push(`• ${v.title}`);
        lines.push(`  https://youtu.be/${v.videoId}`);
        lines.push(
          `  views: ${fmtNum(v.viewAfter)}, likes: ${fmtNum(v.likeAfter)}, comments: ${fmtNum(v.commentAfter)}`
        );
      }
      const remaining = r.allVideos.length - shown.length;
      if (remaining > 0) {
        lines.push(`…and ${remaining} more video${remaining === 1 ? "" : "s"} (full list saved; future updates report changes on all ${r.allVideos.length}).`);
      }
    }
    lines.push("");
    lines.push("Saved baseline. Next status update in 3 hours.");
  } else if (
    (r.subscriberDelta === null || r.subscriberDelta === 0) &&
    r.videoChanges.length === 0
  ) {
    lines.push(`📺 ${r.channelTitle}`);
    lines.push("");
    lines.push(`No changes since last check. Subscribers steady at ${fmtNum(r.subscriberAfter)}.`);
  } else {
    lines.push(`📺 ${r.channelTitle} — 3-hour status`);
    lines.push("");
    if (r.subscriberDelta !== null && r.subscriberDelta !== 0) {
      lines.push(
        `Subscribers: ${fmtNum(r.subscriberAfter)}  (${fmtDelta(r.subscriberDelta)} since last check)`
      );
    } else {
      lines.push(`Subscribers: ${fmtNum(r.subscriberAfter)} (unchanged at this resolution)`);
    }
    if (r.videoChanges.length > 0) {
      lines.push("");
      lines.push("Changes:");
      for (const v of r.videoChanges) {
        for (const line of videoDeltaLines(v)) lines.push(line);
      }
    }
  }

  if (r.scrapeMode === "channel-only") {
    lines.push("");
    lines.push("_channel-only scrape — like/comment deltas unavailable this run_");
  } else if (r.scrapeMode === "partial") {
    lines.push("");
    lines.push("_partial scrape — some video pages couldn't be reached this run_");
  }

  if (r.warnings.length > 0) {
    lines.push("");
    lines.push(`_note: ${r.warnings[0]}_`);
  }

  return lines.join("\n");
}
