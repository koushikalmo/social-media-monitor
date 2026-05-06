---
name: youtube_snapshot
description: Scrape a YouTube channel — current subscriber count and recent videos with view, like, comment counts. Two tools: ad-hoc snapshot, and a cron-friendly status report that diffs against the last run.
---

# YouTube Snapshot + Status Report

This skill drives two tools provided by the `youtube-snapshot` plugin.

## Tools

- `youtube_snapshot(channel, maxVideos?)` — read-only, no state. Use for ad-hoc questions.
- `youtube_status_report(channel, maxVideos?)` — fetches the same data, **also** compares to the last run, persists state, returns deltas. **Use this on the cron schedule.**

## When to call which

| User says / cron fires | Tool |
|---|---|
| "snapshot @foo" / "what's @foo doing right now?" / "give me the latest stats" | `youtube_snapshot` |
| The 3-hour cron message *("run the periodic check on …")* | `youtube_status_report` |
| "what changed in the last 3 hours?" | `youtube_status_report` |

Never call both in the same agent run — they hit the same pages.

## Output of `youtube_status_report`

```json
{
  "channelId": "UC...",
  "channelTitle": "...",
  "scrapedAt": "2026-05-06T...",
  "isFirstRun": false,
  "scrapeMode": "full" | "partial" | "channel-only",
  "subscriberBefore": 1000,
  "subscriberAfter": 1005,
  "subscriberDelta": 5,
  "videoChanges": [
    {
      "videoId": "abc123",
      "title": "...",
      "likeBefore": 10, "likeAfter": 13, "likeDelta": 3,
      "commentBefore": 2, "commentAfter": 4, "commentDelta": 2,
      "viewBefore": 100, "viewAfter": 240, "viewDelta": 140,
      "likeBecameNull": false,
      "commentBecameNull": false
    }
  ],
  "allVideos": [ /* same shape, every recent video, even unchanged */ ],
  "warnings": []
}
```

`videoChanges` is the subset of videos with at least one non-zero delta. `allVideos` is the full list including unchanged videos — useful only on first run.

## How to format the Telegram message (cron path)

### `isFirstRun: true` → baseline

```
📺 <channelTitle> — initial baseline

Subscribers: <subscriberAfter>

Tracking <count> recent videos:
• <title>  likes: <likeAfter>, comments: <commentAfter>, views: <viewAfter>

_Saved baseline. Next status update in 3 hours._
```

### `isFirstRun: false` and **no changes** (`subscriberDelta === 0` and `videoChanges` is empty)

Send a brief "all quiet" line, not the full table:

```
📺 <channelTitle>

No changes since last check. Subscribers steady at <subscriberAfter>.
```

(If `subscriberDelta` is 0 but the channel has >1k subs, mention rounding: *"Subscriber count unchanged at this resolution (YouTube rounds counts above 1k)."*)

### `isFirstRun: false` and **something changed**

```
📺 <channelTitle> — 3-hour status

Subscribers: <subscriberAfter> (<+/-N> since last check)

Changes:
• <title>
  likes: <before> → <after>  (<+/-N>)
  comments: <before> → <after>  (<+/-N>)
  views: <before> → <after>  (<+/-N>)
```

Skip per-video lines for `delta === 0` on each metric. Use `—` for null. Truncate titles longer than 80 chars.

If `scrapeMode !== "full"` add an italic line at the end:
- `_partial scrape — N video page(s) blocked_` (for `partial`)
- `_channel-only scrape — video pages rate-limited; like/comment deltas unavailable this run_` (for `channel-only`)

If `warnings` is non-empty, append the first warning as `_note: <text>_`.

## On voice / interactive questions

For questions like "any new likes?" — call `youtube_status_report` (it diffs and updates state, that's what the user wants). For "what's the channel doing right now?" without comparison context — call `youtube_snapshot`.

## Constraints

- Subscriber counts are rounded by YouTube above 1k. A `subscriberDelta` of 0 on a large channel may be rounding, not literal zero.
- Like and comment counts can come back null for two reasons: YouTube's anti-bot served CAPTCHA (`scrapeMode: "channel-only"` or `"partial"`), or the parser missed the markup. The plugin distinguishes these in `warnings`.
- Never include raw JSON in user-visible Telegram messages.
- A `likeBecameNull: true` (or `commentBecameNull`) means we used to see a number and now don't. Mention it in the warning line: *"likes hidden by YouTube on N video(s) this run"*.
