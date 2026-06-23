// channel-level analytics for the digest: the same headline numbers studio shows
// on its overview card — views, watch time, net subs — each against the prior
// window, plus the audience split and lifetime views. opt-in (YT_ANALYTICS=true),
// read-only, and wrapped so a bad run drops the block instead of killing the post.
//
// window length is WINDOW_DAYS. the api has no "7d"/"28d" preset — you just hand
// it a date range — so the window is ours to pick and the labels follow it.
//
// needs OAuth as an owner/manager (an api key can't read analytics):
//   YT_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN  (refresh-token grant per run)
// lifetime views is the one number that comes off the Data API instead:
//   YT_DATA_API_KEY + YT_CHANNEL (a UC… id).
// the "vs prev" delta stands in for studio's "typical performance" band, which is
// computed server-side and never exposed. impressions/CTR likewise — studio only.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const HTTP_TIMEOUT_MS = 15_000;
// analytics lands ~2 days late, so stop the window there — otherwise the last day
// is half-counted and quietly drags every total down.
const ANALYTICS_LAG_DAYS = 2;
// reporting window. change this one number and the metrics, the comparison, and
// the rendered labels all move with it.
const WINDOW_DAYS = 7;

export type ChannelAnalytics = {
  startDate: string;
  endDate: string;
  // current window
  views: number;
  watchTimeHours: number;
  subscribersNet: number; // gained - lost
  avgViewDurationSec: number;
  // prior window — the baseline we compare against; left 0 when it's unavailable
  prevViews: number;
  prevWatchTimeHours: number;
  prevSubscribersNet: number;
  // audience
  subscribedShare: number | null; // 0..1 of views from subscribers
  topAgeGroups: string[]; // e.g. ["age25-34 (41%)", "age18-24 (22%)"]
  lifetimeViews: number | null; // Data API; null when unavailable
};

// the api wants a bare UTC date, not a full ISO timestamp.
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// the window we report on: WINDOW_DAYS up to the lag cutoff. exported so tests can
// pin it against a fixed clock.
export function analyticsWindow(now = new Date()): { startDate: string; endDate: string } {
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - ANALYTICS_LAG_DAYS);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1));
  return { startDate: ymd(start), endDate: ymd(end) };
}

// the window immediately before that one — what the "vs prev" delta measures against.
export function previousWindow(now = new Date()): { startDate: string; endDate: string } {
  const cur = analyticsWindow(now);
  const prevEnd = new Date(`${cur.startDate}T00:00:00Z`);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (WINDOW_DAYS - 1));
  return { startDate: ymd(prevStart), endDate: ymd(prevEnd) };
}

// blow up early and by name — a blank secret only turns into a vague google 400
// a few calls later, which is miserable to debug.
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

// trade the refresh token for an access token. nothing downstream works without
// it, so a failure here is fatal on purpose.
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
    // not json → no token; the raw body still rides along in the error below.
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      `yt-analytics: token refresh failed ${res.status}: ${text.slice(0, 200) || "(empty body)"}`
    );
  }
  return json.access_token as string;
}

type QueryResult = { cols: string[]; rows: any[][] };

// one reports.query call. hands back column names + rows so callers can look a
// value up by name — the api doesn't promise column order.
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

// which channel to pull. prefer the explicit id in YT_CHANNEL — channel==MINE
// resolves to whatever channel the authorized account personally owns, which for
// a Brand-Account manager is the wrong (or an empty) channel and comes back 403.
// an explicit channel id reads the org's channel directly. falls back to MINE
// when YT_CHANNEL isn't a UC… id.
export function analyticsIds(): string {
  const ch = process.env.YT_CHANNEL?.trim();
  return ch && ch.startsWith("UC") ? `channel==${ch}` : "channel==MINE";
}

// the headline numbers for one window. no dimensions means a single summary row;
// pull each metric out by its column name.
async function coreFor(token: string, startDate: string, endDate: string): Promise<CoreMetrics> {
  const q = await query(token, {
    ids: analyticsIds(),
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

// lifetime views off the Data API. completely optional — no key, a non-UC channel,
// or any error just drops the line, it never throws.
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

// token first, then the current and prior windows, then the nice-to-haves. the
// current window is the only thing we can't do without — everything else is
// best-effort and just drops its own line if it fails.
export async function fetchAnalytics(): Promise<ChannelAnalytics> {
  const token = await getAccessToken();
  const w = analyticsWindow();
  const pw = previousWindow();

  // the must-have.
  const cur = await coreFor(token, w.startDate, w.endDate);

  // only feeds the delta; if it fails we just won't render one.
  let prev: CoreMetrics = { views: 0, minutes: 0, avgDur: 0, subsNet: 0 };
  try {
    prev = await coreFor(token, pw.startDate, pw.endDate);
  } catch {
    // leave it zeroed; comparisonLine drops the delta when prev is 0.
  }

  const dateRange = { startDate: w.startDate, endDate: w.endDate, ids: analyticsIds() };

  // how much of the audience was already subscribed.
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

  // the top few age buckets, biggest first.
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

  const lifetimeViews = await fetchLifetimeViews();

  return {
    startDate: w.startDate,
    endDate: w.endDate,
    views: cur.views,
    watchTimeHours: Math.round(cur.minutes / 60),
    subscribersNet: cur.subsNet,
    avgViewDurationSec: cur.avgDur,
    prevViews: prev.views,
    prevWatchTimeHours: Math.round(prev.minutes / 60),
    prevSubscribersNet: prev.subsNet,
    subscribedShare,
    topAgeGroups,
    lifetimeViews,
  };
}

// "Label: value  (↑/↓ N% vs prev Nd)". with no baseline (prev 0 — new channel, or
// the prior-window call failed) there's no honest delta, so we just show the value.
function comparisonLine(label: string, value: string, curr: number, prev: number): string {
  if (prev <= 0) return `${label}: ${value}`;
  const pct = ((curr - prev) / prev) * 100;
  const arrow = pct > 0 ? "↑" : pct < 0 ? "↓" : "→";
  return `${label}: ${value}  (${arrow} ${Math.abs(pct).toFixed(0)}% vs prev ${WINDOW_DAYS}d)`;
}

// net subs can go negative, so always show the sign.
function fmtSigned(n: number): string {
  return n >= 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

// stitch the block together. the optional lines only appear when their data
// actually arrived, so a half-failed run still reads as deliberate, not broken.
export function formatAnalyticsBlock(a: ChannelAnalytics): string {
  const mm = Math.floor(a.avgViewDurationSec / 60);
  const ss = String(Math.round(a.avgViewDurationSec % 60)).padStart(2, "0");
  const lines: string[] = [
    "",
    `📊 Last ${WINDOW_DAYS} days (${a.startDate} → ${a.endDate})`,
    comparisonLine("Views", a.views.toLocaleString(), a.views, a.prevViews),
    comparisonLine("Watch time", `${a.watchTimeHours.toLocaleString()} hrs`, a.watchTimeHours, a.prevWatchTimeHours),
    comparisonLine("Subscribers", fmtSigned(a.subscribersNet), a.subscribersNet, a.prevSubscribersNet),
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
  // impressions/CTR are studio-only; the line stays here, commented, so turning the
  // "see studio" pointer back on is a one-liner.
  // lines.push("_impressions: see YouTube Studio (no API)_");
  return lines.join("\n");
}
