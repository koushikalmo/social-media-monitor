---
name: youtube_snapshot
description: One-shot scrape of a YouTube channel — subscriber count, recent video titles with view, like and comment counts. No diffing, no schedule.
---

# YouTube Snapshot

Tool: `youtube_snapshot(channel, maxVideos?)`. Scrapes the channel's public pages once and returns the current state. No state file, no cron — call only when the user asks.

## When to call

Call this tool when the user asks for current stats on a YouTube channel:

- "snapshot @eagle3dstreaming"
- "what's the channel doing?"
- "how many subs / likes / comments does <channel> have?"

Do NOT call this on a schedule.

## Output shape

```json
{
  "channelId": "UCxxxxxx",
  "channelTitle": "...",
  "subscriberCount": 1000,
  "subscriberCountText": "1K subscribers",
  "scrapedAt": "2026-05-03T12:00:00.000Z",
  "mode": "full" | "partial" | "channel-only",
  "videos": [
    {
      "videoId": "abc123",
      "title": "...",
      "viewCount": 89,
      "viewCountText": "89 views",
      "likeCount": 1,
      "likeCountText": "...",
      "commentCount": 0
    }
  ],
  "warnings": ["..."]
}
```

Any number field may be `null` when scraping couldn't extract it (Shorts often hide likes; some videos disable comments). Show `—` rather than fabricating a number.

## Modes — adapt the message to what we got

The `mode` field tells you how complete the snapshot is. Always honor it:

### `mode: "full"`

Channel page and every video page succeeded. Full data available.

```
📺 <channelTitle>
Subscribers: <subscriberCount> (<subscriberCountText>)

Recent videos:
• <title>
  https://youtu.be/<videoId>
  views: <viewCount>, likes: <likeCount>, comments: <commentCount>
```

### `mode: "partial"`

Channel page OK, some video pages failed. Show data we have; for failed videos display `—` for likes/comments. Append a brief italic line if there are warnings:

```
📺 <channelTitle>
Subscribers: <subscriberCount> (<subscriberCountText>)

Recent videos:
• <title>
  https://youtu.be/<videoId>
  views: <viewCount>, likes: <likeCount or —>, comments: <commentCount or —>

_note: <count> video page(s) couldn't be scraped this run — try again in a few minutes for full data._
```

### `mode: "channel-only"`

Every video page was blocked (CAPTCHA / rate-limit). The channel-level data (name, subs, video titles, view counts) is still good. Be explicit about the limitation so the user understands why no like/comment counts appear:

```
📺 <channelTitle>
Subscribers: <subscriberCount> (<subscriberCountText>)

Recent videos (channel-page data only — like/comment counts unavailable this run):
• <title>
  https://youtu.be/<videoId>
  views: <viewCount>

_YouTube is rate-limiting individual video pages right now. Try again in a few minutes._
```

## On hard errors

If the tool itself throws (e.g. channel page returned CAPTCHA, or the channel doesn't exist), tell the user plainly: "Couldn't fetch the channel — YouTube is rate-limiting this host right now; try again in a few minutes." or "That channel handle/ID couldn't be resolved." Don't paste raw error messages or stack traces into chat.

## Constraints

- YouTube rounds public subscriber counts (steps of 100 in the 1k–10k range, 3 sig figs above 10k).
- Like and comment counts come from each video's watch page, fetched sequentially with a small delay between requests to avoid bot-detection bursts.
- This is best-effort scraping. Field locations in YouTube's HTML change occasionally; when they do, fewer fields will populate. The tool degrades gracefully (returns nulls + warnings, picks an honest `mode`) instead of crashing.
