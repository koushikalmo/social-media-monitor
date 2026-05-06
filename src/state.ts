import * as fs from "node:fs";
import * as path from "node:path";

// per-channel state lives at <workspace>/youtube-state/<channelId>.json
// kept tiny — just enough to compute deltas on the next run

export type StoredVideo = {
  title: string;
  likeCount: number | null;
  commentCount: number | null;
  viewCount: number | null;
};

export type ChannelState = {
  channelId: string;
  channelTitle: string;
  lastRun: string;
  subscriberCount: number | null;
  videos: Record<string, StoredVideo>;
};

export function stateDir(workspace: string): string {
  return path.join(workspace, "youtube-state");
}

export function stateFilePath(workspace: string, channelId: string): string {
  return path.join(stateDir(workspace), `${channelId}.json`);
}

export function loadState(workspace: string, channelId: string): ChannelState | null {
  const p = stateFilePath(workspace, channelId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ChannelState;
  } catch {
    // corrupt file → rebuild a baseline rather than tripping on bad json forever
    return null;
  }
}

// atomic write: tmp + rename, so a kill mid-write can't leave a half-flushed file
export function saveState(workspace: string, state: ChannelState): void {
  const p = stateFilePath(workspace, state.channelId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}
