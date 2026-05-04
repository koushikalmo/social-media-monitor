import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { scrapeChannel } from "./scrape.js";

export default definePluginEntry({
  id: "youtube-snapshot",
  name: "YouTube Snapshot",
  register(api) {
    api.registerTool({
      name: "youtube_snapshot",
      description:
        "Scrape a YouTube channel's public homepage and recent video pages once and return a snapshot: subscriber count, recent video titles with view, like and comment counts. Pure HTML scraping — no API key, no scheduled polling, no state. Call this only when the user asks for the latest stats.",
      parameters: Type.Object({
        channel: Type.String({
          description: "Channel ID like UCxxxxxx or a handle like @eagle3dstreaming",
        }),
        maxVideos: Type.Optional(
          Type.Integer({
            description: "Number of recent videos to enrich with like/comment counts (default 5)",
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
  },
});
