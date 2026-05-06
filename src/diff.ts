import type { ChannelSnapshot } from "./scrape.js";
import type { ChannelState, StoredVideo } from "./state.js";

export type VideoDelta = {
  videoId: string;
  title: string;
  likeBefore: number | null;
  likeAfter: number | null;
  likeDelta: number | null;
  commentBefore: number | null;
  commentAfter: number | null;
  commentDelta: number | null;
  viewBefore: number | null;
  viewAfter: number | null;
  viewDelta: number | null;
  // when prev had stats but current run came back null we want the operator
  // to know — could be a parser regression or yt hiding the field
  likeBecameNull: boolean;
  commentBecameNull: boolean;
};

export type StatusReport = {
  channelId: string;
  channelTitle: string;
  scrapedAt: string;
  isFirstRun: boolean;
  // mirror scrape mode so the agent can phrase appropriately
  scrapeMode: ChannelSnapshot["mode"];
  subscriberBefore: number | null;
  subscriberAfter: number | null;
  subscriberDelta: number | null;
  videoChanges: VideoDelta[];
  // every video in the snapshot, deltas inclusive — useful when first-run
  // reporting wants to dump everything we have
  allVideos: VideoDelta[];
  warnings: string[];
};

function delta(prev: number | null, curr: number | null): number | null {
  if (prev === null || curr === null) return null;
  return curr - prev;
}

export function computeReport(
  snapshot: ChannelSnapshot,
  prev: ChannelState | null
): StatusReport {
  const isFirstRun = prev === null;

  const subscriberBefore = prev?.subscriberCount ?? null;
  const subscriberAfter = snapshot.subscriberCount;
  const subscriberDelta = isFirstRun ? null : delta(subscriberBefore, subscriberAfter);

  const allVideos: VideoDelta[] = snapshot.videos.map((v) => {
    const prevV: StoredVideo | undefined = prev?.videos?.[v.videoId];
    const likeBefore = prevV?.likeCount ?? null;
    const commentBefore = prevV?.commentCount ?? null;
    const viewBefore = prevV?.viewCount ?? null;
    return {
      videoId: v.videoId,
      title: v.title,
      likeBefore,
      likeAfter: v.likeCount,
      likeDelta: isFirstRun ? null : delta(likeBefore, v.likeCount),
      commentBefore,
      commentAfter: v.commentCount,
      commentDelta: isFirstRun ? null : delta(commentBefore, v.commentCount),
      viewBefore,
      viewAfter: v.viewCount,
      viewDelta: isFirstRun ? null : delta(viewBefore, v.viewCount),
      likeBecameNull: !isFirstRun && likeBefore !== null && v.likeCount === null,
      commentBecameNull:
        !isFirstRun && commentBefore !== null && v.commentCount === null,
    };
  });

  // "videoChanges" = the subset where something actually moved. on first run
  // this is empty; the caller should fall back to allVideos for reporting.
  const videoChanges = allVideos.filter(
    (v) =>
      (v.likeDelta !== null && v.likeDelta !== 0) ||
      (v.commentDelta !== null && v.commentDelta !== 0) ||
      (v.viewDelta !== null && v.viewDelta !== 0)
  );

  return {
    channelId: snapshot.channelId,
    channelTitle: snapshot.channelTitle,
    scrapedAt: snapshot.scrapedAt,
    isFirstRun,
    scrapeMode: snapshot.mode,
    subscriberBefore,
    subscriberAfter,
    subscriberDelta,
    videoChanges,
    allVideos,
    warnings: [...snapshot.warnings],
  };
}

// next state = previous state with the snapshot's numbers folded in. when a
// field came back null this run we keep the previous numeric value so we can
// still detect a delta the *next* time it shows up.
export function nextStateFrom(
  snapshot: ChannelSnapshot,
  prev: ChannelState | null
): ChannelState {
  const videoMap: Record<string, StoredVideo> = { ...(prev?.videos ?? {}) };
  for (const v of snapshot.videos) {
    const existing = videoMap[v.videoId];
    videoMap[v.videoId] = {
      title: v.title || existing?.title || "",
      likeCount: v.likeCount ?? existing?.likeCount ?? null,
      commentCount: v.commentCount ?? existing?.commentCount ?? null,
      viewCount: v.viewCount ?? existing?.viewCount ?? null,
    };
  }
  return {
    channelId: snapshot.channelId,
    channelTitle: snapshot.channelTitle,
    lastRun: snapshot.scrapedAt,
    subscriberCount: snapshot.subscriberCount,
    videos: videoMap,
  };
}
