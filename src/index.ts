import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import * as os from "node:os";
import * as path from "node:path";
import { scrapeChannel } from "./scrape.js";
import { runStatusReport } from "./check.js";

const DEFAULT_WORKSPACE = path.join(os.homedir(), ".openclaw", "workspace");

export default definePluginEntry({
  id: "youtube-snapshot",
  name: "YouTube Snapshot",
  register(api) {
    const workspace = api.runtime?.workspace ?? DEFAULT_WORKSPACE;

    // ad-hoc, read-only — for "what's the channel doing right now" questions
    api.registerTool({
      name: "youtube_snapshot",
      description:
        "Scrape a YouTube channel's public homepage and recent video pages once and return a snapshot: subscriber count, recent video titles with view, like and comment counts. No state, no diffing — call this for ad-hoc 'right now' questions from the user.",
      parameters: Type.Object({
        channel: Type.String({
          description: "Channel ID like UCxxxxxx or a handle like @eagle3dstreaming",
        }),
        maxVideos: Type.Optional(
          Type.Integer({
            description: "How many recent videos to enrich with like/comment counts (default 5)",
            default: 5,
          })
        ),
      }),
      async execute(_id, params) {
        const p = params as { channel: string; maxVideos?: number };
        const snap = await scrapeChannel(p.channel, p.maxVideos ?? 5);
        return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
      },
    });

    // periodic / cron-triggered — does the same scrape but compares to the
    // previous run and persists state. report shape carries before/after for
    // every metric so the agent can format a status update with deltas.
    api.registerTool({
      name: "youtube_status_report",
      description:
        "Run the periodic 3-hour status check on a YouTube channel. Scrapes current numbers, compares against the last run, persists state, and returns a full report with subscriber delta, per-video like/comment/view deltas, and warnings. Use this on the cron schedule.",
      parameters: Type.Object({
        channel: Type.String({
          description: "Channel ID like UCxxxxxx or a handle like @eagle3dstreaming",
        }),
        maxVideos: Type.Optional(
          Type.Integer({
            description: "How many recent videos to track (default 5)",
            default: 5,
          })
        ),
      }),
      async execute(_id, params) {
        const p = params as { channel: string; maxVideos?: number };
        const report = await runStatusReport(p.channel, workspace, p.maxVideos ?? 5);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      },
    });
  },
});
