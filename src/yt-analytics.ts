// tldr: pull the Studio "Overview" numbers (views / watch time / net subs, each
// vs the prior 28d) + audience split + lifetime views, and render a text block
// for the digest. read-only, opt-in (YT_ANALYTICS=true), never blocks the report.
//
// auth: the Analytics API needs OAuth as an owner/manager — an API key won't do.
//   YT_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN  (refresh-token grant each run)
// lifetime views piggybacks on the Data API: YT_DATA_API_KEY + YT_CHANNEL (UC…).
// the "vs prev 28d" delta is our stand-in for Studio's "typical performance"
// band — that band is modelled server-side and never shipped over the API.
// impressions/CTR are the same story (Studio-only), so deliberately not here.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const HTTP_TIMEOUT_MS = 15_000;
// analytics finalises on a ~2-day lag; end the window at the cutoff so the tail
// isn't a half-counted day quietly dragging the totals down.
const ANALYTICS_LAG_DAYS = 2;
const WINDOW_DAYS = 28;

export type ChannelAnalytics = {
  startDate: string;
  endDate: string;
  // current window
  views28d: number;
  watchTimeHours: number;
  subscribersNet28d: number; // gained - lost
  avgViewDurationSec: number;
  // prior window — the comparison baseline; left 0 when it's unavailable
  prevViews28d: number;
  prevWatchTimeHours: number;
  prevSubscribersNet28d: number;
  // audience
  subscribedShare: number | null; // 0..1 of views from subscribers
  topAgeGroups: string[]; // e.g. ["age25-34 (41%)", "age18-24 (22%)"]
  lifetimeViews: number | null; // Data API; null when unavailable
};

// the api wants bare UTC YYYY-MM-DD, not ISO timestamps.
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// current reporting window: 28 inclusive days ending at the lag cutoff.
// exported so the date math can be pinned against a fixed clock in tests.
export function analyticsWindow(now = new Date()): { startDate: string; endDate: string } {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - ANALYTICS_LAG_DAYS);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  return { startDate: ymd(start), endDate: ymd(end) };
}

// the 28 days immediately before analyticsWindow() — i.e. the "vs prev" baseline.
export function previousWindow(now = new Date()): { startDate: string; endDate: string } {
  const cur = analyticsWindow(now);
  const prevEnd = new Date(`${cur.startDate}T00:00:00Z`);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (WINDOW_DAYS - 1));
  return { startDate: ymd(prevStart), endDate: ymd(prevEnd) };
}

// fail loud and specific on a missing secret — an empty string just buys you an
// opaque google 400 three calls later.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `yt-analytics: ${name} not set. analytics needs OAuth credentials ` +
        `(YT_OAUTH_CLIENT_ID, YT_OAUTH_CLIENT_SECRET, YT_OAUTH_REFRESH_TOKEN).`
    );
  }
  return v.trim();
}

// refresh-token -> short-lived access token. fatal by design: every report call
// below needs it, so there's nothing useful to do if this fails.
async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: requireEnv("YT_OAUTH_CLIENT_ID"),
    client_secret: requireEnv("YT_OAUTH_CLIENT_SECRET"),
    refresh_token: requireEnv("YT_OAUTH_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // non-json body -> no token; the raw text is surfaced in the error below.
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      `yt-analytics: token refresh failed ${res.status}: ${text.slice(0, 200) || "(empty body)"}`
    );
  }
  return json.access_token as string;
}

type QueryResult = { cols: string[]; rows: any[][] };

// thin reports.query wrapper: hands back column names + raw rows and lets the
// caller index by metric name, since the api doesn't promise column order.
async function query(token: string, params: Record<string, string>): Promise<QueryResult> {
  const url = `${REPORTS_URL}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`yt-analytics: reports ${res.status}: ${text.slice(0, 200) || "(empty body)"}`);
  }
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`yt-analytics: reports returned non-JSON: ${text.slice(0, 120)}`);
  }
  const cols: string[] = (json.columnHeaders ?? []).map((c: any) => c.name);
  const rows: any[][] = json.rows ?? [];
  return { cols, rows };
}

type CoreMetrics = {
  views: number;
  minutes: number;
  avgDur: number;
  subsNet: number;
};

// headline metrics for one window. no dimensions => a single summary row; index
// by header name (see query) rather than trusting positional order.
async function coreFor(token: string, startDate: string, endDate: string): Promise<CoreMetrics> {
  const q = await query(token, {
    ids: "channel==MINE",
    startDate,
    endDate,
    metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
  });
  const row = q.rows[0] ?? [];
  const col = (name: string): number => {
    const i = q.cols.indexOf(name);
    return i >= 0 ? Number(row[i] ?? 0) : 0;
  };
  return {
    views: col("views"),
    minutes: col("estimatedMinutesWatched"),
    avgDur: col("averageViewDuration"),
    subsNet: col("subscribersGained") - col("subscribersLost"),
  };
}

// lifetime channel views off the Data API. optional + swallow-all: no key, a
// non-UC channel, or any error just drops the line — it never throws.
async function fetchLifetimeViews(): Promise<number | null> {
  const key = process.env.YT_DATA_API_KEY?.trim();
  const ch = process.env.YT_CHANNEL?.trim();
  if (!key || !ch || !ch.startsWith("UC")) return null;
  try {
    const url = `${DATA_CHANNELS_URL}?part=statistics&id=${encodeURIComponent(ch)}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const v = json?.items?.[0]?.statistics?.viewCount;
    return v != null ? Number(v) : null;
  } catch {
    return null;
  }
}

// run order: token, then current + prior core, then the optional extras. only
// the current-window call is load-bearing; every optional bit that fails simply
// omits its own line instead of sinking the whole block.
export async function fetchAnalytics(): Promise<ChannelAnalytics> {
  const token = await getAccessToken();
  const w = analyticsWindow();
  const pw = previousWindow();

  // current window — the one call we let throw.
  const cur = await coreFor(token, w.startDate, w.endDate);

  // prior window — feeds the delta; zeros (=> no delta rendered) if it errors.
  let prev: CoreMetrics = { views: 0, minutes: 0, avgDur: 0, subsNet: 0 };
  try {
    prev = await coreFor(token, pw.startDate, pw.endDate);
  } catch {
    // swallow: comparison just disappears, current totals still post.
  }

  const dateRange = { startDate: w.startDate, endDate: w.endDate, ids: "channel==MINE" };

  // audience #1: share of views coming from subscribers.
  let subscribedShare: number | null = null;
  try {
    const sub = await query(token, { ...dateRange, dimensions: "subscribedStatus", metrics: "views" });
    let subViews = 0;
    let total = 0;
    for (const r of sub.rows) {
      const v = Number(r[1] ?? 0);
      total += v;
      if (String(r[0]).toUpperCase() === "SUBSCRIBED") subViews += v;
    }
    if (total > 0) subscribedShare = subViews / total;
  } catch {
    // optional
  }

  // audience #2: top-3 age buckets by viewer %.
  let topAgeGroups: string[] = [];
  try {
    const demo = await query(token, { ...dateRange, dimensions: "ageGroup", metrics: "viewerPercentage" });
    topAgeGroups = demo.rows
      .map((r) => ({ g: String(r[0]), p: Number(r[1] ?? 0) }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 3)
      .map((x) => `${x.g} (${x.p.toFixed(0)}%)`);
  } catch {
    // optional
  }

  // lifetime total (Data API, optional).
  const lifetimeViews = await fetchLifetimeViews();

  return {
    startDate: w.startDate,
    endDate: w.endDate,
    views28d: cur.views,
    watchTimeHours: Math.round(cur.minutes / 60),
    subscribersNet28d: cur.subsNet,
    avgViewDurationSec: cur.avgDur,
    prevViews28d: prev.views,
    prevWatchTimeHours: Math.round(prev.minutes / 60),
    prevSubscribersNet28d: prev.subsNet,
    subscribedShare,
    topAgeGroups,
    lifetimeViews,
  };
}

// "Label: value  (↑/↓ N% vs prev 28d)". prev<=0 means no usable baseline (new
// channel, or the prior-window call failed) -> drop the delta, keep the value.
function comparisonLine(label: string, value: string, curr: number, prev: number): string {
  if (prev <= 0) return `${label}: ${value}`;
  const pct = ((curr - prev) / prev) * 100;
  const arrow = pct > 0 ? "↑" : pct < 0 ? "↓" : "→";
  return `${label}: ${value}  (${arrow} ${Math.abs(pct).toFixed(0)}% vs prev 28d)`;
}

// net subs can be negative; always emit the sign so +0 / -12 read unambiguously.
function fmtSigned(n: number): string {
  return n >= 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

// build the text block. optional lines (audience / age / lifetime) only appear
// when their data actually arrived, so a degraded run still reads intentionally.
export function formatAnalyticsBlock(a: ChannelAnalytics): string {
  const mm = Math.floor(a.avgViewDurationSec / 60);
  const ss = String(Math.round(a.avgViewDurationSec % 60)).padStart(2, "0");
  const lines: string[] = [
    "",
    `📊 Last 28 days (${a.startDate} → ${a.endDate})`,
    comparisonLine("Views", a.views28d.toLocaleString(), a.views28d, a.prevViews28d),
    comparisonLine("Watch time", `${a.watchTimeHours.toLocaleString()} hrs`, a.watchTimeHours, a.prevWatchTimeHours),
    comparisonLine("Subscribers", fmtSigned(a.subscribersNet28d), a.subscribersNet28d, a.prevSubscribersNet28d),
    `Avg view duration: ${mm}:${ss}`,
  ];
  if (a.subscribedShare !== null) {
    lines.push(`Audience: ${Math.round(a.subscribedShare * 100)}% subscribed`);
  }
  if (a.topAgeGroups.length > 0) {
    lines.push(`Top age groups: ${a.topAgeGroups.join(", ")}`);
  }
  if (a.lifetimeViews !== null) {
    lines.push(`Total channel views: ${a.lifetimeViews.toLocaleString()}`);
  }
  // impressions/CTR are Studio-only; line kept (commented) so flipping the
  // "see Studio" pointer back on is a one-liner if we ever want it.
  // lines.push("_impressions: see YouTube Studio (no API)_");
  return lines.join("\n");
}
