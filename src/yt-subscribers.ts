// real-time subscriber count via third-party counters (no API key).
// mixerno primary, livecounts fallback.

const HTTP_TIMEOUT_MS = 8_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type SubscriberSource = "mixerno" | "livecounts";
export type SubscriberLookup = {
  count: number | null;
  source: SubscriberSource | "fallback";
  error: string | null;
};

type MixernoResponse = {
  counts?: Array<{ value?: string; count?: number }>;
};
type LiveCountsResponse = {
  followerCount?: number;
  subscribers?: number;
  subscriberCount?: number;
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fromMixerno(channelId: string): Promise<number> {
  const url = `https://mixerno.space/api/youtube-channel-counter/user/${channelId}`;
  const json = (await fetchJson(url)) as MixernoResponse;
  const subs = json.counts?.find((c) => c.value === "subscribers")?.count;
  if (typeof subs !== "number" || !Number.isFinite(subs) || subs < 0) {
    throw new Error("mixerno: subscribers field missing or invalid");
  }
  return subs;
}

async function fromLiveCounts(channelId: string): Promise<number> {
  const url = `https://api.livecounts.io/youtube-live-subscriber-counter/stats/${channelId}`;
  const json = (await fetchJson(url)) as LiveCountsResponse;
  const subs = json.followerCount ?? json.subscribers ?? json.subscriberCount;
  if (typeof subs !== "number" || !Number.isFinite(subs) || subs < 0) {
    throw new Error("livecounts: subscribers field missing or invalid");
  }
  return subs;
}

const PROVIDERS: Record<SubscriberSource, (id: string) => Promise<number>> = {
  mixerno: fromMixerno,
  livecounts: fromLiveCounts,
};

export async function getExactSubscriberCount(
  channelId: string,
  preferred: SubscriberSource = "mixerno"
): Promise<SubscriberLookup> {
  const order: SubscriberSource[] =
    preferred === "mixerno" ? ["mixerno", "livecounts"] : ["livecounts", "mixerno"];
  const errors: string[] = [];
  for (const src of order) {
    try {
      const count = await PROVIDERS[src](channelId);
      return { count, source: src, error: null };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { count: null, source: "fallback", error: errors.join("; ") };
}
