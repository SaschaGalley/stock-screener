import { TechnicalIndicators, TechnicalReturns } from '../types.js';

export interface DailyBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TRADING_DAYS_PER_YEAR = 252;

// ─── Pure indicator functions ─────────────────────────────────────────────────

export function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

export function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  // Seed with SMA of first n values
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function emaSeries(values: number[], n: number): number[] {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out.push(e);
  for (let i = n; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** Wilder's RSI (smoothed). Returns the latest value, or null on insufficient data. */
export function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= n;
  avgLoss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  line:      number | null;
  signal:    number | null;
  histogram: number | null;
}

export function macd(closes: number[], fast = 12, slow = 26, signalN = 9): MacdResult {
  if (closes.length < slow + signalN) return { line: null, signal: null, histogram: null };
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  // Align: slow series starts later (index slow-1 in original); fastSeries starts at fast-1.
  // Trim fastSeries to the same starting index as slowSeries.
  const offset = slow - fast;
  const fastAligned = fastSeries.slice(offset);
  const len = Math.min(fastAligned.length, slowSeries.length);
  const macdLine: number[] = [];
  for (let i = 0; i < len; i++) {
    macdLine.push(fastAligned[i] - slowSeries[i]);
  }
  if (macdLine.length < signalN) return { line: macdLine[macdLine.length - 1] ?? null, signal: null, histogram: null };
  const signalSeries = emaSeries(macdLine, signalN);
  const line = macdLine[macdLine.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  return { line, signal, histogram: line - signal };
}

export interface BollingerResult {
  upper:     number | null;
  mid:       number | null;
  lower:     number | null;
  percentB:  number | null;
}

export function bollinger(closes: number[], n = 20, k = 2): BollingerResult {
  if (closes.length < n) return { upper: null, mid: null, lower: null, percentB: null };
  const slice = closes.slice(-n);
  const mid = slice.reduce((a, b) => a + b, 0) / n;
  const variance = slice.reduce((acc, v) => acc + (v - mid) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const price = closes[closes.length - 1];
  const percentB = upper === lower ? null : (price - lower) / (upper - lower);
  return { upper, mid, lower, percentB };
}

/** ATR via Wilder's smoothing of true range. */
export function atr(bars: DailyBar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < n) return null;
  let a = trs.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < trs.length; i++) {
    a = (a * (n - 1) + trs[i]) / n;
  }
  return a;
}

/** Annualised stdev of log returns over the trailing n+1 closes. */
export function historicalVolatility(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const slice = closes.slice(-(n + 1));
  const logRet: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0 && slice[i] > 0) logRet.push(Math.log(slice[i] / slice[i - 1]));
  }
  if (logRet.length < 2) return null;
  const mean = logRet.reduce((a, b) => a + b, 0) / logRet.length;
  const variance = logRet.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (logRet.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Current drawdown from the high observed in the trailing `lookback` closes. */
export function drawdownFromHigh(closes: number[], lookback = TRADING_DAYS_PER_YEAR): number | null {
  if (closes.length === 0) return null;
  const slice = closes.slice(-lookback);
  const high = Math.max(...slice);
  const last = closes[closes.length - 1];
  if (high <= 0) return null;
  return (last - high) / high;
}

/** Stochastic %K (14, smoothed by simple SMA over `smoothK`). */
export function stochasticK(highs: number[], lows: number[], closes: number[], n = 14, smoothK = 3): number | null {
  if (closes.length < n + smoothK - 1) return null;
  const ks: number[] = [];
  for (let i = closes.length - smoothK; i < closes.length; i++) {
    const winH = Math.max(...highs.slice(i - n + 1, i + 1));
    const winL = Math.min(...lows.slice(i - n + 1, i + 1));
    const c = closes[i];
    ks.push(winH === winL ? 50 : ((c - winL) / (winH - winL)) * 100);
  }
  return ks.reduce((a, b) => a + b, 0) / smoothK;
}

/** Stochastic %D = SMA of %K. We compute %K series first, then SMA(3). */
export function stochasticD(highs: number[], lows: number[], closes: number[], n = 14, smoothK = 3, smoothD = 3): number | null {
  if (closes.length < n + smoothK + smoothD - 2) return null;
  // Build %K series for the last `smoothD` periods
  const dWindow = smoothD + smoothK - 1;
  const kSeries: number[] = [];
  for (let end = closes.length - dWindow + 1; end <= closes.length; end++) {
    const ks: number[] = [];
    for (let i = end - smoothK; i < end; i++) {
      const winH = Math.max(...highs.slice(i - n + 1, i + 1));
      const winL = Math.min(...lows.slice(i - n + 1, i + 1));
      const c = closes[i];
      ks.push(winH === winL ? 50 : ((c - winL) / (winH - winL)) * 100);
    }
    kSeries.push(ks.reduce((a, b) => a + b, 0) / smoothK);
  }
  return kSeries.slice(-smoothD).reduce((a, b) => a + b, 0) / smoothD;
}

/** Williams %R (typically 14). Returns value in [-100, 0]. */
export function williamsR(highs: number[], lows: number[], closes: number[], n = 14): number | null {
  if (closes.length < n) return null;
  const winH = Math.max(...highs.slice(-n));
  const winL = Math.min(...lows.slice(-n));
  const c = closes[closes.length - 1];
  if (winH === winL) return -50;
  return ((winH - c) / (winH - winL)) * -100;
}

/** Commodity Channel Index (typically 20). */
export function cci(highs: number[], lows: number[], closes: number[], n = 20): number | null {
  if (closes.length < n) return null;
  const tps: number[] = [];
  for (let i = 0; i < closes.length; i++) tps.push((highs[i] + lows[i] + closes[i]) / 3);
  const recent = tps.slice(-n);
  const mean = recent.reduce((a, b) => a + b, 0) / n;
  const meanDev = recent.reduce((acc, v) => acc + Math.abs(v - mean), 0) / n;
  if (meanDev === 0) return 0;
  return (tps[tps.length - 1] - mean) / (0.015 * meanDev);
}

/** Momentum: latest close − close `n` sessions ago. */
export function momentum(closes: number[], n = 10): number | null {
  if (closes.length <= n) return null;
  return closes[closes.length - 1] - closes[closes.length - 1 - n];
}

/** Total return between the latest close and the close `daysBack` sessions earlier. */
export function totalReturn(closes: number[], daysBack: number): number | null {
  if (closes.length <= daysBack) return null;
  const past = closes[closes.length - 1 - daysBack];
  const last = closes[closes.length - 1];
  if (past === 0) return null;
  return (last - past) / past;
}

/** Year-to-date return: from the first close of the current calendar year. */
export function ytdReturn(bars: DailyBar[]): number | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const yr = last.date.getFullYear();
  const firstOfYear = bars.find((b) => b.date.getFullYear() === yr);
  if (!firstOfYear || firstOfYear.close === 0) return null;
  return (last.close - firstOfYear.close) / firstOfYear.close;
}

// ─── Compose into the TechnicalIndicators result ─────────────────────────────

export interface TechnicalsInputs {
  bars: DailyBar[];
  spyBars?: DailyBar[];
  sectorBars?: DailyBar[];
}

function returnsBlock(bars: DailyBar[]): TechnicalReturns {
  const closes = bars.map((b) => b.close);
  return {
    d1:  totalReturn(closes, 1),
    w1:  totalReturn(closes, 5),
    m1:  totalReturn(closes, 21),
    m3:  totalReturn(closes, 63),
    m6:  totalReturn(closes, 126),
    ytd: ytdReturn(bars),
    y1:  totalReturn(closes, 252),
  };
}

function relativeReturn3M(stockBars: DailyBar[], benchBars: DailyBar[] | undefined): number | null {
  if (!benchBars || benchBars.length === 0) return null;
  const a = totalReturn(stockBars.map((b) => b.close), 63);
  const b = totalReturn(benchBars.map((x) => x.close), 63);
  if (a === null || b === null) return null;
  return a - b;
}

export function computeTechnicals(input: TechnicalsInputs): TechnicalIndicators {
  const { bars, spyBars, sectorBars } = input;
  const closes = bars.map((b) => b.close);
  const highs  = bars.map((b) => b.high);
  const lows   = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);
  const price = closes[closes.length - 1] ?? null;

  // Moving averages — short, medium, long for both SMA and EMA
  const sma10  = sma(closes, 10);
  const sma20  = sma(closes, 20);
  const sma30  = sma(closes, 30);
  const sma50  = sma(closes, 50);
  const sma100 = sma(closes, 100);
  const sma200 = sma(closes, 200);
  const ema10  = ema(closes, 10);
  const ema20  = ema(closes, 20);
  const ema30  = ema(closes, 30);
  const ema50  = ema(closes, 50);
  const ema100 = ema(closes, 100);
  const ema200 = ema(closes, 200);

  const macdRes = macd(closes);
  const boll    = bollinger(closes, 20, 2);
  const atr14   = atr(bars, 14);

  // New oscillators
  const stochK14    = stochasticK(highs, lows, closes, 14, 3);
  const stochD14    = stochasticD(highs, lows, closes, 14, 3, 3);
  const williamsR14 = williamsR(highs, lows, closes, 14);
  const cci20       = cci(highs, lows, closes, 20);
  const momentum10  = momentum(closes, 10);

  const recent252 = closes.slice(-252);
  const high52 = recent252.length > 0 ? Math.max(...recent252) : null;
  const low52  = recent252.length > 0 ? Math.min(...recent252) : null;
  const position52WPct = price !== null && high52 !== null && low52 !== null && high52 > low52
    ? (price - low52) / (high52 - low52)
    : null;

  const avgVolume30 = volumes.length >= 30
    ? volumes.slice(-30).reduce((a, b) => a + b, 0) / 30
    : null;
  const currentVolRatio = avgVolume30 && avgVolume30 > 0 && volumes.length > 0
    ? volumes[volumes.length - 1] / avgVolume30
    : null;

  return {
    returns:           returnsBlock(bars),
    // Moving averages
    sma10, sma20, sma30, sma50, sma100, sma200,
    ema10, ema20, ema30, ema50, ema100, ema200,
    distFromSMA50Pct:  price !== null && sma50  !== null && sma50  > 0 ? (price - sma50)  / sma50  : null,
    distFromSMA200Pct: price !== null && sma200 !== null && sma200 > 0 ? (price - sma200) / sma200 : null,
    goldenCross:       sma50 !== null && sma200 !== null ? sma50 > sma200 : null,
    // Oscillators
    rsi14:             rsi(closes, 14),
    macdLine:          macdRes.line,
    macdSignal:        macdRes.signal,
    macdHistogram:     macdRes.histogram,
    stochK14,
    stochD14,
    williamsR14,
    cci20,
    momentum10,
    // Bands & volatility
    bollingerUpper:    boll.upper,
    bollingerMid:      boll.mid,
    bollingerLower:    boll.lower,
    bollingerPercentB: boll.percentB,
    atr14,
    atr14Pct:          atr14 !== null && price !== null && price > 0 ? atr14 / price : null,
    hv30:              historicalVolatility(closes, 30),
    hv90:              historicalVolatility(closes, 90),
    drawdownFromHighPct: drawdownFromHigh(closes, 252),
    position52WPct,
    avgVolume30,
    currentVolRatio,
    rsVsSPY3M:    relativeReturn3M(bars, spyBars),
    rsVsSector3M: relativeReturn3M(bars, sectorBars),
  };
}
