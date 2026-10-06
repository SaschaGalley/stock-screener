/**
 * The chart, read the way a chartist reads it: where it turned, where it
 * keeps turning, which way it runs and how far it is from the edges.
 *
 * The overview's timing column says in one word where the price sits in its
 * three-month channel. This is the rest of that reading — the swing highs and
 * lows, the prices they cluster at (support below, resistance above), the
 * regression channels over a quarter, half a year and a year, the trend lines
 * through the last swings, where the year's volume changed hands, the moving
 * averages and their crosses, divergences between price and RSI, breakouts,
 * open gaps, and how tight the bands are.
 *
 * None of it is a tested prediction. The timing readings in `timing.ts` went
 * through the backtest; these did not, and the page says so. They describe the
 * chart — which is what someone reading it before a purchase wants to see at
 * a glance, and what an LLM is handed when asked to read the chart (see
 * `chart-read-service.ts`).
 *
 * Pure and dependency-free: the web app imports the types.
 */

/** One trading day. High, low and open are null on bars from a closes-only backfill. */
export interface ChartBar {
  day:    string;
  open:   number | null;
  high:   number | null;
  low:    number | null;
  close:  number;
  volume: number | null;
}

/** A turn the zigzag confirmed: the price moved this far the other way afterwards. */
export interface Pivot {
  /** Index into the bars the analysis was given. */
  i:     number;
  day:   string;
  price: number;
  kind:  'high' | 'low';
  /** False for the current leg's extreme, which has not been reversed yet. */
  confirmed: boolean;
}

export interface PriceLevel {
  price:     number;
  /** Below the last close it is support, above it resistance — whatever it was before. */
  kind:      'support' | 'resistance';
  /** Swing points within the level's band. */
  touches:   number;
  firstDay:  string;
  lastDay:   string;
  /** Turned the price from both sides: a former resistance now support, or the reverse. */
  flipped:   boolean;
  /** Where the level comes from. Several can coincide; the strongest reason is kept. */
  source:    'swing' | 'high52' | 'low52' | 'poc';
  /** From the last close, as a ratio: −0.05 is 5 % below. */
  distance:  number;
  /** The same distance in typical daily moves. */
  distanceAtr: number | null;
  /** 0–1 among the levels of this chart: touches weighted by how recent they are. */
  strength:  number;
}

export interface Channel {
  sessions: number;
  label:    string;
  fromDay:  string;
  toDay:    string;
  /** Annualised slope of the log price: 0.2 is about +22 % a year. */
  slope:    number;
  /** How straight the path was, 0–1. A channel with a low R² is a cloud, not a channel. */
  r2:       number;
  /** Where the last close sits, in the residuals' standard deviations. */
  z:        number;
  /** Centre line and the ±2σ edges, in price, at the first and the last session. */
  center:   [number, number];
  upper:    [number, number];
  lower:    [number, number];
}

export interface TrendLine {
  kind:   'support' | 'resistance';
  from:   { day: string; price: number };
  to:     { day: string; price: number };
  /** The line's price at the last session. */
  now:    number;
  /** Annualised slope of the line in log price. */
  slope:  number;
  /** A close beyond the line by more than the tolerance since its second point. */
  broken: boolean;
  /** The day it broke, when it did. */
  brokenAt: string | null;
}

export interface VolumeProfile {
  sessions:  number;
  bins:      { lo: number; hi: number; volume: number }[];
  /** Point of control: the middle of the bin with the most volume. */
  poc:       number;
  /** The range around the POC that holds 70 % of the volume. */
  valueLow:  number;
  valueHigh: number;
}

export interface Fibonacci {
  /** The year's swing: up when the low came first. */
  dir:    'up' | 'down';
  from:   { day: string; price: number };
  to:     { day: string; price: number };
  levels: { ratio: number; price: number }[];
}

export interface MovingAverages {
  sma20:  number | null;
  sma50:  number | null;
  sma200: number | null;
  /** Close over 20 over 50 over 200, or the reverse. */
  stack:  'bull' | 'bear' | 'mixed';
  /** The last time the 50-day line crossed the 200-day line, within the bars given. */
  cross:  { kind: 'golden' | 'death'; day: string } | null;
  /** Direction of the 200-day line over the last month, as a ratio. */
  sma200Slope: number | null;
}

export interface Divergence {
  kind:  'bullish' | 'bearish';
  from:  { day: string; price: number; rsi: number };
  to:    { day: string; price: number; rsi: number };
}

export interface Breakout {
  dir:    'up' | 'down';
  day:    string;
  level:  number;
  source: PriceLevel['source'];
  /** The day's volume over the fifty sessions before it. */
  volumeRatio: number | null;
}

/** A price range a gap left untraded, still not filled. */
export interface Gap {
  day:  string;
  dir:  'up' | 'down';
  /** The part of the gap not yet traded back into. */
  low:  number;
  high: number;
}

export interface Squeeze {
  /** Bollinger bandwidth (4σ over the 20-day mean). */
  bandwidth:  number;
  /** Its rank among the year's bandwidths, 0–1: 0.05 is tighter than 95 % of the year. */
  percentile: number;
}

/** One thing the chart says, as a sentence, with which way it leans. */
export interface ChartFinding {
  key:  string;
  tone: 'bull' | 'bear' | 'neutral';
  text: string;
}

export interface ChartAnalysis {
  asOf:   string;
  close:  number;
  /** Mean true range of the last 14 sessions, in price. */
  atr:    number | null;
  pivots: Pivot[];
  structure: {
    trend: 'up' | 'down' | 'sideways';
    /** What the last two swing highs and lows did. */
    highs: 'higher' | 'lower' | 'equal' | null;
    lows:  'higher' | 'lower' | 'equal' | null;
    text:  string;
  };
  levels:      PriceLevel[];
  channels:    Channel[];
  trendlines:  TrendLine[];
  profile:     VolumeProfile | null;
  fibonacci:   Fibonacci | null;
  ma:          MovingAverages;
  rsi14:       number | null;
  squeeze:     Squeeze | null;
  divergences: Divergence[];
  breakouts:   Breakout[];
  gaps:        Gap[];
  findings:    ChartFinding[];
}

const YEAR = 252;
const ATR_SESSIONS = 14;
/** A swing must reverse by this many typical daily moves to count as a turn. */
export const SWING_ATR = 3;
/** Price levels within this many daily moves of each other are one level… */
const LEVEL_BAND_ATR = 0.6;
/** …but never narrower than this share of the price. */
const LEVEL_BAND_MIN = 0.008;
/** Levels further than this from the price are history, not a level to watch. */
const LEVEL_RANGE = 0.35;
/** Shown on each side of the price. */
const LEVELS_PER_SIDE = 4;
/** A touch a year ago counts e⁻¹ as much as one today. */
const LEVEL_DECAY = YEAR;
const CHANNELS = [
  { sessions: 63,  label: '3 Monate' },
  { sessions: 126, label: '6 Monate' },
  { sessions: 252, label: '1 Jahr' },
] as const;
const PROFILE_BINS = 32;
const VALUE_AREA = 0.7;
const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];
/** Breakouts older than this are the trend, not news. */
const BREAKOUT_SESSIONS = 10;
/** Divergences whose second swing is older than this have played out. */
const DIVERGENCE_SESSIONS = 40;
/** A gap smaller than this share of a daily move is noise. */
const GAP_MIN_ATR = 0.25;
const GAP_SESSIONS = 126;
const SQUEEZE_PERCENTILE = 0.1;

// ─── Series helpers ──────────────────────────────────────────────────────────

const hi = (b: ChartBar) => b.high ?? Math.max(b.close, b.open ?? b.close);
const lo = (b: ChartBar) => b.low ?? Math.min(b.close, b.open ?? b.close);
const full = (b: ChartBar) => b.high !== null && b.low !== null && b.open !== null;

/** Simple moving average at every bar; null until the window is full. */
export function smaSeries(closes: readonly number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let s = 0;
  for (let k = 0; k < closes.length; k++) {
    s += closes[k];
    if (k >= n) s -= closes[k - n];
    if (k >= n - 1) out[k] = s / n;
  }
  return out;
}

/** True range at every bar; the first has only its own range. Close-only bars fall back to the close-to-close move. */
function trueRanges(bars: readonly ChartBar[]): number[] {
  return bars.map((b, k) => {
    const prev = k > 0 ? bars[k - 1].close : null;
    const range = hi(b) - lo(b);
    if (prev === null) return range;
    return Math.max(range, Math.abs(hi(b) - prev), Math.abs(lo(b) - prev));
  });
}

/** Mean true range over the trailing window at every bar. */
function atrSeries(bars: readonly ChartBar[], n = ATR_SESSIONS): (number | null)[] {
  return smaSeries(trueRanges(bars), n);
}

/** Wilder's RSI at every bar, null until it has seeded. */
export function rsiSeries(closes: readonly number[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let k = 1; k <= n; k++) {
    const d = closes[k] - closes[k - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let k = n + 1; k < closes.length; k++) {
    const d = closes[k] - closes[k - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[k] = value();
  }
  return out;
}

// ─── Swings ──────────────────────────────────────────────────────────────────

/**
 * The zigzag: a high is a high once the price has come down from it by
 * `SWING_ATR` typical daily moves, a low once it has risen that far. The
 * threshold follows the volatility of the day, so a quiet year and a wild one
 * both give turns of the same meaning. The leg still running ends in an
 * unconfirmed extreme — the high of a rise not yet reversed.
 */
export function zigzag(bars: readonly ChartBar[], atr: readonly (number | null)[], mult = SWING_ATR): Pivot[] {
  const out: Pivot[] = [];
  if (bars.length < 2) return out;
  const pivot = (i: number, kind: Pivot['kind'], confirmed = true): Pivot =>
    ({ i, day: bars[i].day, price: kind === 'high' ? hi(bars[i]) : lo(bars[i]), kind, confirmed });
  // Before the ATR has warmed up, a move of 4 % stands in for it.
  const th = (k: number) => mult * (atr[k] ?? bars[k].close * 0.04 / mult);

  let dir: 1 | -1 | 0 = 0;
  let hiI = 0, loI = 0;
  for (let k = 1; k < bars.length; k++) {
    const H = hi(bars[k]), L = lo(bars[k]);
    if (dir === 0) {
      if (H > hi(bars[hiI])) hiI = k;
      if (L < lo(bars[loI])) loI = k;
      if (hiI < k && hi(bars[hiI]) - L >= th(k)) { out.push(pivot(hiI, 'high')); dir = -1; loI = k; }
      else if (loI < k && H - lo(bars[loI]) >= th(k)) { out.push(pivot(loI, 'low')); dir = 1; hiI = k; }
    } else if (dir === 1) {
      if (H >= hi(bars[hiI])) hiI = k;
      else if (hi(bars[hiI]) - L >= th(k)) { out.push(pivot(hiI, 'high')); dir = -1; loI = k; }
    } else {
      if (L <= lo(bars[loI])) loI = k;
      else if (H - lo(bars[loI]) >= th(k)) { out.push(pivot(loI, 'low')); dir = 1; hiI = k; }
    }
  }
  if (dir === 1 && hiI > (out.at(-1)?.i ?? -1)) out.push(pivot(hiI, 'high', false));
  if (dir === -1 && loI > (out.at(-1)?.i ?? -1)) out.push(pivot(loI, 'low', false));
  return out;
}

/** Up, down or sideways, from what the last two confirmed highs and lows did. */
function structureOf(pivots: readonly Pivot[], tol: number): ChartAnalysis['structure'] {
  const confirmed = pivots.filter((p) => p.confirmed);
  const last2 = (kind: Pivot['kind']) => confirmed.filter((p) => p.kind === kind).slice(-2);
  const cmp = (ps: Pivot[]): 'higher' | 'lower' | 'equal' | null => {
    if (ps.length < 2) return null;
    const d = ps[1].price - ps[0].price;
    return Math.abs(d) <= tol ? 'equal' : d > 0 ? 'higher' : 'lower';
  };
  const highs = cmp(last2('high'));
  const lows = cmp(last2('low'));
  const word = { higher: 'höhere', lower: 'tiefere', equal: 'gleich hohe' } as const;
  if (highs === null || lows === null) {
    return { trend: 'sideways', highs, lows, text: 'Zu wenige Wendepunkte für eine Trendstruktur.' };
  }
  const both = `${word[highs]} Hochs, ${word[lows]} Tiefs`;
  if (highs === 'higher' && lows === 'higher') return { trend: 'up', highs, lows, text: `Aufwärtstrend: ${both}.` };
  if (highs === 'lower' && lows === 'lower') return { trend: 'down', highs, lows, text: `Abwärtstrend: ${both}.` };
  if (highs === 'lower' && lows === 'higher') return { trend: 'sideways', highs, lows, text: `Die Spanne zieht sich zusammen: ${both} (symmetrisches Dreieck).` };
  if (highs === 'equal' && lows === 'higher') return { trend: 'sideways', highs, lows, text: `Seitwärts mit Druck nach oben: ${both} (aufsteigendes Dreieck).` };
  if (highs === 'lower' && lows === 'equal') return { trend: 'sideways', highs, lows, text: `Seitwärts mit Druck nach unten: ${both} (absteigendes Dreieck).` };
  if (highs === 'higher' && lows === 'lower') return { trend: 'sideways', highs, lows, text: `Die Spanne weitet sich: ${both}.` };
  return { trend: 'sideways', highs, lows, text: `Seitwärts: ${both}.` };
}

// ─── Levels ──────────────────────────────────────────────────────────────────

interface Cluster { prices: number[]; pivots: Pivot[]; weight: number }

/**
 * Swing points that turned at about the same price, merged into one level.
 * Greedy over the sorted prices: a pivot joins the cluster below it while it
 * stays within the band of that cluster's mean.
 */
function clusterPivots(pivots: readonly Pivot[], band: number, lastIndex: number): Cluster[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const out: Cluster[] = [];
  for (const p of sorted) {
    const c = out.at(-1);
    const mean = c ? c.prices.reduce((a, b) => a + b, 0) / c.prices.length : 0;
    const w = Math.exp(-(lastIndex - p.i) / LEVEL_DECAY);
    if (c && p.price - mean <= band) { c.prices.push(p.price); c.pivots.push(p); c.weight += w; }
    else out.push({ prices: [p.price], pivots: [p], weight: w });
  }
  return out;
}

function levelsOf(
  bars: readonly ChartBar[], pivots: readonly Pivot[], atr: number | null, profile: VolumeProfile | null,
): PriceLevel[] {
  const last = bars.length - 1;
  const close = bars[last].close;
  const band = Math.max((atr ?? 0) * LEVEL_BAND_ATR, close * LEVEL_BAND_MIN);
  const clusters = clusterPivots(pivots, band, last);

  const year = bars.slice(-YEAR);
  let h52 = 0, l52 = 0;
  year.forEach((b, k) => { if (hi(b) >= hi(year[h52])) h52 = k; if (lo(b) <= lo(year[l52])) l52 = k; });
  const off = bars.length - year.length;
  const extremes = [
    { price: hi(year[h52]), day: year[h52].day, i: off + h52, source: 'high52' as const },
    { price: lo(year[l52]), day: year[l52].day, i: off + l52, source: 'low52' as const },
  ];

  const raw: (Omit<PriceLevel, 'kind' | 'distance' | 'distanceAtr' | 'strength'> & { weight: number })[] = [];
  for (const c of clusters) {
    const price = c.prices.reduce((a, b) => a + b, 0) / c.prices.length;
    const days = c.pivots.map((p) => p.day).sort();
    raw.push({
      price, touches: c.pivots.length, firstDay: days[0], lastDay: days.at(-1)!,
      flipped: c.pivots.some((p) => p.kind === 'high') && c.pivots.some((p) => p.kind === 'low'),
      source: 'swing', weight: c.weight,
    });
  }
  // The year's extremes and the volume's centre are levels whether or not the zigzag turned there.
  for (const e of extremes) {
    const near = raw.find((r) => Math.abs(r.price - e.price) <= band);
    if (near) { near.source = e.source; near.price = e.price; continue; }
    raw.push({ price: e.price, touches: 1, firstDay: e.day, lastDay: e.day, flipped: false, source: e.source, weight: Math.exp(-(last - e.i) / LEVEL_DECAY) });
  }
  if (profile) {
    const near = raw.find((r) => Math.abs(r.price - profile.poc) <= band);
    if (near) { if (near.source === 'swing') near.source = 'poc'; near.weight += 0.5; }
    else raw.push({ price: profile.poc, touches: 0, firstDay: bars[bars.length - profile.sessions].day, lastDay: bars[last].day, flipped: false, source: 'poc', weight: 0.5 });
  }

  const maxWeight = Math.max(...raw.map((r) => r.weight), 1e-9);
  const levels: PriceLevel[] = raw
    .filter((r) => Math.abs(r.price / close - 1) <= LEVEL_RANGE)
    .map(({ weight, ...r }) => ({
      ...r,
      kind: r.price < close ? 'support' as const : 'resistance' as const,
      distance: r.price / close - 1,
      distanceAtr: atr ? (r.price - close) / atr : null,
      strength: weight / maxWeight,
    }));
  const below = levels.filter((l) => l.kind === 'support').sort((a, b) => b.price - a.price).slice(0, LEVELS_PER_SIDE);
  const above = levels.filter((l) => l.kind === 'resistance').sort((a, b) => a.price - b.price).slice(0, LEVELS_PER_SIDE);
  return [...above.reverse(), ...below];
}

// ─── Channels and lines ──────────────────────────────────────────────────────

/** A least-squares line through the log closes of the last `n` sessions, and the ±2σ band around it. */
export function regressionChannel(bars: readonly ChartBar[], n: number, label: string): Channel | null {
  if (bars.length < n) return null;
  const xs = bars.slice(-n);
  const ys = xs.map((b) => Math.log(b.close));
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (k - mx) * (ys[k] - my);
    sxx += (k - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let k = 0; k < n; k++) ss += (ys[k] - (a + b * k)) ** 2;
  const sd = Math.sqrt(ss / (n - 2));
  const at = (k: number, s: number) => Math.exp(a + b * k + s * sd);
  return {
    sessions: n, label, fromDay: xs[0].day, toDay: xs[n - 1].day,
    slope: b * YEAR,
    r2: syy > 0 ? 1 - ss / syy : 0,
    z: sd > 0 ? (ys[n - 1] - (a + b * (n - 1))) / sd : 0,
    center: [at(0, 0), at(n - 1, 0)],
    upper:  [at(0, 2), at(n - 1, 2)],
    lower:  [at(0, -2), at(n - 1, -2)],
  };
}

/**
 * The line through the last two confirmed swing lows, and the one through the
 * last two swing highs, extended to today in log price. Broken when a close
 * since the second point went through it by more than the level band.
 */
function trendlinesOf(bars: readonly ChartBar[], pivots: readonly Pivot[], band: number): TrendLine[] {
  const out: TrendLine[] = [];
  const last = bars.length - 1;
  for (const kind of ['low', 'high'] as const) {
    const ps = pivots.filter((p) => p.confirmed && p.kind === kind).slice(-2);
    if (ps.length < 2 || ps[1].i === ps[0].i) continue;
    const [p, q] = ps;
    const slope = (Math.log(q.price) - Math.log(p.price)) / (q.i - p.i);
    const line = (k: number) => Math.exp(Math.log(p.price) + slope * (k - p.i));
    let brokenAt: string | null = null;
    for (let k = q.i + 1; k <= last; k++) {
      const c = bars[k].close;
      if (kind === 'low' ? c < line(k) - band : c > line(k) + band) { brokenAt = bars[k].day; break; }
    }
    out.push({
      kind: kind === 'low' ? 'support' : 'resistance',
      from: { day: p.day, price: p.price },
      to:   { day: q.day, price: q.price },
      now: line(last), slope: slope * YEAR, broken: brokenAt !== null, brokenAt,
    });
  }
  return out;
}

// ─── Volume ──────────────────────────────────────────────────────────────────

/**
 * Where the year's shares changed hands: each day's volume spread evenly over
 * the range it traded in. Null when too few bars carry a volume — a profile
 * of half the year would put its centre wherever the data happens to be.
 */
export function volumeProfile(bars: readonly ChartBar[], sessions = YEAR, nBins = PROFILE_BINS): VolumeProfile | null {
  const xs = bars.slice(-sessions);
  const withVol = xs.filter((b) => b.volume !== null && b.volume > 0);
  if (xs.length < 60 || withVol.length < xs.length * 0.8) return null;
  const min = Math.min(...xs.map(lo)), max = Math.max(...xs.map(hi));
  if (!(max > min)) return null;
  const width = (max - min) / nBins;
  const vol = new Array<number>(nBins).fill(0);
  for (const b of withVol) {
    const l = lo(b), h = hi(b);
    const from = Math.min(nBins - 1, Math.floor((l - min) / width));
    const to = Math.min(nBins - 1, Math.floor((h - min) / width));
    if (h <= l || from === to) { vol[from] += b.volume!; continue; }
    for (let k = from; k <= to; k++) {
      const overlap = Math.min(h, min + (k + 1) * width) - Math.max(l, min + k * width);
      vol[k] += b.volume! * Math.max(0, overlap) / (h - l);
    }
  }
  const total = vol.reduce((a, b) => a + b, 0);
  let poc = 0;
  vol.forEach((v, k) => { if (v > vol[poc]) poc = k; });
  // The value area grows from the POC toward whichever neighbour traded more.
  let a = poc, z = poc, inside = vol[poc];
  while (inside < total * VALUE_AREA && (a > 0 || z < nBins - 1)) {
    const down = a > 0 ? vol[a - 1] : -1;
    const up = z < nBins - 1 ? vol[z + 1] : -1;
    if (up >= down) inside += vol[++z]; else inside += vol[--a];
  }
  return {
    sessions: xs.length,
    bins: vol.map((v, k) => ({ lo: min + k * width, hi: min + (k + 1) * width, volume: v })),
    poc: min + (poc + 0.5) * width,
    valueLow: min + a * width,
    valueHigh: min + (z + 1) * width,
  };
}

// ─── The rest ────────────────────────────────────────────────────────────────

function fibonacciOf(bars: readonly ChartBar[]): Fibonacci | null {
  const year = bars.slice(-YEAR);
  if (year.length < 60) return null;
  let h = 0, l = 0;
  year.forEach((b, k) => { if (hi(b) >= hi(year[h])) h = k; if (lo(b) <= lo(year[l])) l = k; });
  const H = hi(year[h]), L = lo(year[l]);
  if (!(H > L)) return null;
  const dir = l < h ? 'up' : 'down';
  // Retracements of a rise are measured down from its high; of a fall, up from its low.
  const levels = FIB_RATIOS.map((ratio) => ({ ratio, price: dir === 'up' ? H - ratio * (H - L) : L + ratio * (H - L) }));
  const a = { day: year[dir === 'up' ? l : h].day, price: dir === 'up' ? L : H };
  const b = { day: year[dir === 'up' ? h : l].day, price: dir === 'up' ? H : L };
  return { dir, from: a, to: b, levels };
}

function movingAverages(closes: readonly number[], days: readonly string[]): MovingAverages {
  const s20 = smaSeries(closes, 20), s50 = smaSeries(closes, 50), s200 = smaSeries(closes, 200);
  const last = closes.length - 1;
  const c = closes[last];
  const [a, b, d] = [s20[last], s50[last], s200[last]];
  const stack = a !== null && b !== null && d !== null
    ? (c > a && a > b && b > d ? 'bull' : c < a && a < b && b < d ? 'bear' : 'mixed')
    : 'mixed';
  let cross: MovingAverages['cross'] = null;
  for (let k = last; k > 0 && cross === null; k--) {
    const now = s50[k] !== null && s200[k] !== null ? s50[k]! - s200[k]! : null;
    const before = s50[k - 1] !== null && s200[k - 1] !== null ? s50[k - 1]! - s200[k - 1]! : null;
    if (now === null || before === null) break;
    if (before <= 0 && now > 0) cross = { kind: 'golden', day: days[k] };
    else if (before >= 0 && now < 0) cross = { kind: 'death', day: days[k] };
  }
  const month = last - 21;
  return {
    sma20: a, sma50: b, sma200: d, stack, cross,
    sma200Slope: d !== null && month >= 0 && s200[month] ? d / s200[month]! - 1 : null,
  };
}

function squeezeOf(closes: readonly number[]): Squeeze | null {
  const n = 20;
  if (closes.length < YEAR + n) return null;
  const widths: number[] = [];
  for (let k = closes.length - YEAR; k < closes.length; k++) {
    const xs = closes.slice(k - n + 1, k + 1);
    const m = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    widths.push(m > 0 ? (4 * sd) / m : 0);
  }
  const now = widths.at(-1)!;
  return { bandwidth: now, percentile: widths.filter((w) => w < now).length / widths.length };
}

/**
 * The classic divergence: a new swing high on a weaker RSI (bearish), a new
 * swing low on a stronger one (bullish). Only between the last two confirmed
 * swings of a kind, and only while the second is recent.
 */
function divergencesOf(pivots: readonly Pivot[], rsi: readonly (number | null)[], lastIndex: number): Divergence[] {
  const out: Divergence[] = [];
  for (const kind of ['high', 'low'] as const) {
    const ps = pivots.filter((p) => p.confirmed && p.kind === kind).slice(-2);
    if (ps.length < 2 || lastIndex - ps[1].i > DIVERGENCE_SESSIONS) continue;
    const [p, q] = ps;
    const rp = rsi[p.i], rq = rsi[q.i];
    if (rp === null || rq === null) continue;
    const at = (x: Pivot, r: number) => ({ day: x.day, price: x.price, rsi: r });
    if (kind === 'high' && q.price > p.price && rq < rp - 3) out.push({ kind: 'bearish', from: at(p, rp), to: at(q, rq) });
    if (kind === 'low' && q.price < p.price && rq > rp + 3) out.push({ kind: 'bullish', from: at(p, rp), to: at(q, rq) });
  }
  return out;
}

/** Closes that crossed a level in the last sessions and have stayed across it. */
function breakoutsOf(bars: readonly ChartBar[], levels: readonly PriceLevel[]): Breakout[] {
  const out: Breakout[] = [];
  const last = bars.length - 1;
  const close = bars[last].close;
  const avgVol = (k: number) => {
    const xs = bars.slice(Math.max(0, k - 50), k).map((b) => b.volume).filter((v): v is number => v !== null && v > 0);
    return xs.length >= 20 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  for (const l of levels) {
    if (l.source === 'swing' && l.touches < 2) continue;
    for (let k = last; k > Math.max(0, last - BREAKOUT_SESSIONS); k--) {
      const before = bars[k - 1].close, now = bars[k].close;
      const up = before <= l.price && now > l.price && close > l.price;
      const down = before >= l.price && now < l.price && close < l.price;
      if (!up && !down) continue;
      const avg = avgVol(k);
      out.push({
        dir: up ? 'up' : 'down', day: bars[k].day, level: l.price, source: l.source,
        volumeRatio: avg && bars[k].volume ? bars[k].volume! / avg : null,
      });
      break;
    }
  }
  return out;
}

/** Gaps of the last half year that the price has not traded back into, newest first. */
function gapsOf(bars: readonly ChartBar[], atr: readonly (number | null)[]): Gap[] {
  const out: Gap[] = [];
  const last = bars.length - 1;
  for (let k = Math.max(1, bars.length - GAP_SESSIONS); k <= last; k++) {
    const a = bars[k - 1], b = bars[k];
    if (!full(a) || !full(b)) continue;
    const min = GAP_MIN_ATR * (atr[k] ?? 0);
    let gap: Gap | null = null;
    if (b.low! - a.high! > min) gap = { day: b.day, dir: 'up', low: a.high!, high: b.low! };
    else if (a.low! - b.high! > min) gap = { day: b.day, dir: 'down', low: b.high!, high: a.low! };
    if (!gap) continue;
    // What later bars traded inside the gap closes that part of it.
    for (let j = k + 1; j <= last && gap.high > gap.low; j++) {
      if (gap.dir === 'up') gap.high = Math.min(gap.high, lo(bars[j]));
      else gap.low = Math.max(gap.low, hi(bars[j]));
    }
    if (gap.high - gap.low > min) out.push(gap);
  }
  return out.reverse().slice(0, 4);
}

// ─── Findings ────────────────────────────────────────────────────────────────

const de = (x: number, d = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const pct = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${de(Math.abs(x * 100), d)} %`;
const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(2, 4)}`;
const SOURCE_LABEL: Record<PriceLevel['source'], string> = {
  swing: 'Wendepunkte', high52: 'Jahreshoch', low52: 'Jahrestief', poc: 'Volumenschwerpunkt',
};

const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;
const touchesDe = (n: number) => (n === 1 ? '1 Wendepunkt' : `${n} Wendepunkte`);
/** Within this many daily moves the price is at a level, not between two. */
const AT_LEVEL_ATR = 0.3;

/** A level as a phrase: "182,40 (−3,1 %, 1,4 ATR; 3 Wendepunkte, zuletzt 12.8.26)". */
export function levelPhrase(l: PriceLevel): string {
  const atr = l.distanceAtr !== null ? `, ${de(Math.abs(l.distanceAtr), 1)} ATR` : '';
  const why = l.source === 'swing'
    ? `${touchesDe(l.touches)}, zuletzt ${dayDe(l.lastDay)}${l.flipped ? ', Rollentausch' : ''}`
    : `${SOURCE_LABEL[l.source]}${l.touches > 1 ? `, ${touchesDe(l.touches)}` : ''}`;
  return `${de(l.price)} (${pct(l.distance)}${atr}; ${why})`;
}

/** A channel's move over its own window — annualising a quarter's slope gives numbers nobody saw. */
export function channelMove(c: Channel): number {
  return Math.exp(c.slope * c.sessions / YEAR) - 1;
}

const channelTone = (c: Channel): ChartFinding['tone'] => (c.slope > 0.15 ? 'bull' : c.slope < -0.15 ? 'bear' : 'neutral');

const CHANNEL_NAME: Record<number, { name: string; span: string }> = {
  63: { name: '3-Monats-Kanal', span: '3 Monaten' },
  126: { name: '6-Monats-Kanal', span: '6 Monaten' },
  252: { name: 'Jahreskanal', span: 'einem Jahr' },
};

/** "steigenden 3-Monats-Kanal (+12 % in 3 Monaten) am unteren Rand (−1,4σ)", in the dative or the nominative. */
function channelPhrase(c: Channel, grammatical: 'dat' | 'nom'): string {
  const ending = grammatical === 'dat' ? 'en' : 'e';
  const way = c.slope > 0.15 ? `steigend${ending}` : c.slope < -0.15 ? `fallend${ending}` : `seitwärts laufend${ending}`;
  const where = c.z <= -1 ? 'am unteren Rand' : c.z >= 1 ? 'am oberen Rand' : 'in der Mitte';
  const z = Math.abs(c.z) > 2 ? `, außerhalb des Kanals (${de(c.z, 1)}σ)` : ` (${de(c.z, 1)}σ)`;
  const n = CHANNEL_NAME[c.sessions] ?? { name: `${c.label}-Kanal`, span: c.label };
  return `${way} ${n.name} (${pct(channelMove(c), 0)} in ${n.span}) ${where}${z}`;
}

function findingsOf(a: Omit<ChartAnalysis, 'findings'>): ChartFinding[] {
  const out: ChartFinding[] = [];
  const push = (key: string, tone: ChartFinding['tone'], text: string) => out.push({ key, tone, text });

  push('structure', a.structure.trend === 'up' ? 'bull' : a.structure.trend === 'down' ? 'bear' : 'neutral', a.structure.text);

  const q = a.channels.find((c) => c.sessions === 63);
  if (q) {
    push('channel', channelTone(q), `Im ${channelPhrase(q, 'dat')}${q.r2 < 0.3 ? ' — der Kanal ist unscharf (R² ' + de(q.r2) + ')' : ''}.`);
    // A blurred quarter says little; a longer channel that is straight says more.
    const clear = a.channels.filter((c) => c.sessions > 63 && c.r2 >= 0.5).sort((x, y) => y.r2 - x.r2)[0];
    if (q.r2 < 0.3 && clear) push('channel-long', channelTone(clear), `Klarer ist der ${channelPhrase(clear, 'nom')}, R² ${de(clear.r2)}.`);
  }

  const at = a.levels.find((l) => l.distanceAtr !== null && Math.abs(l.distanceAtr) < AT_LEVEL_ATR);
  if (at) push('at-level', 'neutral', `Der Kurs steht an der Marke ${levelPhrase(at)} — ob sie hält, entscheidet die nächste Bewegung.`);
  const beyond = (l: PriceLevel) => l !== at;
  const support = a.levels.filter((l) => l.kind === 'support' && beyond(l))[0];
  const resistance = a.levels.filter((l) => l.kind === 'resistance' && beyond(l)).at(-1);
  if (support) push('support', 'neutral', `Nächste Unterstützung ${levelPhrase(support)}.`);
  if (resistance) push('resistance', 'neutral', `Nächster Widerstand ${levelPhrase(resistance)}.`);
  if (support && resistance && support.distance < 0) {
    const ratio = resistance.distance / -support.distance;
    push('room', ratio >= 2 ? 'bull' : ratio <= 0.5 ? 'bear' : 'neutral',
      `Bis zum Widerstand ${pct(resistance.distance)}, bis zur Unterstützung ${pct(support.distance)}: Verhältnis ${de(ratio, 1)} : 1.`);
  }

  const ma = a.ma;
  if (ma.stack === 'bull') push('ma', 'bull', 'Kurs über 20-, 50- und 200-Tage-Linie, die Linien steigend gestaffelt.');
  else if (ma.stack === 'bear') push('ma', 'bear', 'Kurs unter 20-, 50- und 200-Tage-Linie, die Linien fallend gestaffelt.');
  else if (ma.sma200 !== null) {
    const over = a.close > ma.sma200;
    push('ma', over ? 'bull' : 'bear', `Kurs ${over ? 'über' : 'unter'} der 200-Tage-Linie (${pct(a.close / ma.sma200 - 1)}), die kürzeren Linien uneinheitlich.`);
  }
  if (ma.cross && daysBetween(ma.cross.day, a.asOf) <= 365) {
    push('cross', ma.cross.kind === 'golden' ? 'bull' : 'bear',
      `${ma.cross.kind === 'golden' ? 'Golden Cross' : 'Death Cross'} am ${dayDe(ma.cross.day)}: die 50-Tage-Linie ${ma.cross.kind === 'golden' ? 'über' : 'unter'} die 200-Tage-Linie.`);
  }

  for (const t of a.trendlines) {
    const name = t.kind === 'support' ? 'Unterstützungslinie' : 'Widerstandslinie';
    if (t.broken) {
      push(`trendline-${t.kind}`, t.kind === 'support' ? 'bear' : 'bull',
        `${name} durch die Wendepunkte vom ${dayDe(t.from.day)} und ${dayDe(t.to.day)} am ${dayDe(t.brokenAt!)} gebrochen.`);
    } else {
      push(`trendline-${t.kind}`, 'neutral',
        `${name} durch ${dayDe(t.from.day)} und ${dayDe(t.to.day)} (${pct(Math.exp(t.slope) - 1, 0)} p. a.) liegt heute bei ${de(t.now)} (${pct(t.now / a.close - 1)}).`);
    }
  }

  for (const b of a.breakouts) {
    const vol = b.volumeRatio !== null ? `, Volumen ${de(b.volumeRatio, 1)}-mal üblich${b.volumeRatio < 1.2 ? ' (schwach bestätigt)' : ''}` : '';
    push(`breakout-${b.level}`, b.dir === 'up' ? 'bull' : 'bear',
      `${b.dir === 'up' ? 'Ausbruch über' : 'Bruch unter'} ${de(b.level)} (${SOURCE_LABEL[b.source]}) am ${dayDe(b.day)}${vol}.`);
  }

  for (const d of a.divergences) {
    push(`divergence-${d.kind}`, d.kind === 'bullish' ? 'bull' : 'bear', d.kind === 'bearish'
      ? `Bärische Divergenz: neues Hoch am ${dayDe(d.to.day)} bei schwächerem RSI (${de(d.to.rsi, 0)} gegen ${de(d.from.rsi, 0)}).`
      : `Bullische Divergenz: neues Tief am ${dayDe(d.to.day)} bei stärkerem RSI (${de(d.to.rsi, 0)} gegen ${de(d.from.rsi, 0)}).`);
  }

  if (a.rsi14 !== null && (a.rsi14 >= 70 || a.rsi14 <= 30)) {
    push('rsi', a.rsi14 >= 70 ? 'bear' : 'bull', `RSI ${de(a.rsi14, 0)}: ${a.rsi14 >= 70 ? 'überkauft' : 'überverkauft'}.`);
  }

  if (a.squeeze && a.squeeze.percentile <= SQUEEZE_PERCENTILE) {
    push('squeeze', 'neutral', `Die Bollinger-Bänder sind so eng wie an kaum einem Tag des Jahres (enger als ${Math.round((1 - a.squeeze.percentile) * 100)} %) — oft die Ruhe vor einer größeren Bewegung, deren Richtung offen ist.`);
  }

  if (a.profile) {
    const p = a.profile;
    const where = a.close > p.valueHigh ? 'über' : a.close < p.valueLow ? 'unter' : 'innerhalb';
    push('profile', where === 'über' ? 'bull' : where === 'unter' ? 'bear' : 'neutral',
      `Volumenschwerpunkt des Jahres bei ${de(p.poc)}; der Kurs liegt ${where} der Zone, in der 70 % gehandelt wurden (${de(p.valueLow)}–${de(p.valueHigh)}).`);
  }

  for (const g of a.gaps.slice(0, 2)) {
    push(`gap-${g.day}`, 'neutral', `Offene Kurslücke ${g.dir === 'up' ? 'nach oben' : 'nach unten'} vom ${dayDe(g.day)}: ${de(g.low)}–${de(g.high)}.`);
  }

  if (a.fibonacci) {
    const f = a.fibonacci;
    const near = f.levels.find((l) => Math.abs(l.price / a.close - 1) <= 0.015);
    if (near) {
      push('fibonacci', 'neutral', `Kurs nahe am ${de(near.ratio * 100, 1)}-%-Retracement (${de(near.price)}) der ${f.dir === 'up' ? 'Aufwärtsbewegung' : 'Abwärtsbewegung'} vom ${dayDe(f.from.day)} bis ${dayDe(f.to.day)}.`);
    }
  }
  return out;
}

// ─── Everything ──────────────────────────────────────────────────────────────

/**
 * The chart read from its bars, oldest first. Null with fewer than sixty
 * sessions — not enough for a swing, let alone a level.
 */
export function chartAnalysis(bars: readonly ChartBar[]): ChartAnalysis | null {
  const xs = bars.filter((b) => b.close > 0);
  if (xs.length < 60) return null;
  const last = xs.length - 1;
  const closes = xs.map((b) => b.close);
  const days = xs.map((b) => b.day);
  const atrs = atrSeries(xs);
  const atr = atrs[last];
  const close = closes[last];
  const band = Math.max((atr ?? 0) * LEVEL_BAND_ATR, close * LEVEL_BAND_MIN);

  const pivots = zigzag(xs, atrs);
  const profile = volumeProfile(xs);
  const levels = levelsOf(xs, pivots, atr, profile);
  const rsi = rsiSeries(closes);
  const partial: Omit<ChartAnalysis, 'findings'> = {
    asOf: days[last], close, atr,
    pivots,
    structure: structureOf(pivots, band),
    levels,
    channels: CHANNELS.map((c) => regressionChannel(xs, c.sessions, c.label)).filter((c): c is Channel => c !== null),
    trendlines: trendlinesOf(xs, pivots, band),
    profile,
    fibonacci: fibonacciOf(xs),
    ma: movingAverages(closes, days),
    rsi14: rsi[last],
    squeeze: squeezeOf(closes),
    divergences: divergencesOf(pivots, rsi, last),
    breakouts: breakoutsOf(xs, levels),
    gaps: gapsOf(xs, atrs),
  };
  return { ...partial, findings: findingsOf(partial) };
}

// ─── The LLM's reading ───────────────────────────────────────────────────────

export const CHART_PATTERN_STATUS = ['forming', 'confirmed', 'failed'] as const;
export const CHART_PATTERN_STATUS_LABEL: Record<(typeof CHART_PATTERN_STATUS)[number], string> = {
  forming: 'in Bildung', confirmed: 'bestätigt', failed: 'gescheitert',
};

/**
 * What a model read in the chart: patterns with their trigger and target,
 * the levels it thinks matter and why, scenarios with concrete prices, and
 * what would prove the reading wrong. Kept as a document (`kind = 'chart'`).
 */
export interface ChartRead {
  /** The last session the model saw. */
  asOf:      string;
  summary:   string;
  trend:     { direction: 'up' | 'down' | 'sideways'; phase: string; comment: string };
  patterns:  {
    name:    string;
    status:  (typeof CHART_PATTERN_STATUS)[number];
    from:    string | null;
    to:      string | null;
    /** The price whose crossing confirms it. */
    trigger: number | null;
    /** The measured move, where the pattern has one. */
    target:  number | null;
    comment: string;
  }[];
  levels:    { price: number; kind: 'support' | 'resistance'; strength: 'strong' | 'medium' | 'weak'; comment: string }[];
  scenarios: { case: 'bull' | 'bear' | 'base'; trigger: string; target: number | null; comment: string }[];
  /** What would make the whole reading wrong. */
  invalidation: string | null;
  watch:     string[];
}

/** A stored reading, as the page receives it. */
export interface ChartReadDoc {
  read:       ChartRead;
  model:      string | null;
  producedAt: string;
}

/** `GET /api/stocks/:symbol/chart` */
export interface ChartResponse {
  symbol:   string;
  currency: string | null;
  bars:     ChartBar[];
  /** Aligned with `bars`. */
  sma: { sma20: (number | null)[]; sma50: (number | null)[]; sma200: (number | null)[] };
  analysis: ChartAnalysis | null;
  read:     ChartReadDoc | null;
}
