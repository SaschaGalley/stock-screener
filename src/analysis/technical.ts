import {
  ATR,
  BollingerBands,
  CCI,
  EMA,
  MACD,
  MOM,
  PercentB,
  RSI,
  SMA,
  StochasticOscillator,
  TechnicalIndicator,
  WilliamsR,
  getAverage,
  getLogReturns,
  getMaximum,
  getMinimum,
  getPercentageChange,
  getStandardDeviation,
} from 'trading-signals';
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

// ─── Bridging trading-signals to our snapshot shape ───────────────────────────
// Every indicator below comes from `trading-signals`. Those are streaming
// indicators: you feed them bar by bar and they carry their own state. We only
// ever want the value at the end of the history, so each one is fed the whole
// series once and then read out — `isStable` is what tells us whether there was
// enough history for a real value, which is where our `null`s come from.

/** Feed a full history into a streaming indicator and read its final value. */
function finalValue<Result, Input>(
  indicator: TechnicalIndicator<Result, Input>,
  inputs: readonly Input[],
): Result | null {
  indicator.updates(inputs, false);
  return indicator.isStable ? indicator.getResult() : null;
}

/** `getPercentageChange` reports percent; every ratio we store is a decimal. */
function ratioChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return getPercentageChange(from, to) / 100;
}

// ─── Derived series metrics without a direct library counterpart ──────────────

/**
 * Annualised stdev of log returns over the trailing n+1 closes. `getLogReturns`
 * throws on non-positive prices, so those are screened out first.
 */
function historicalVolatility(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const slice = closes.slice(-(n + 1));
  if (slice.some((c) => c <= 0)) return null;
  const logReturns = getLogReturns(slice);
  if (logReturns.length < 2) return null;
  return getStandardDeviation(logReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Current drawdown from the high observed in the trailing `lookback` closes.
 * Not `getMaxDrawdown` — that reports the worst drawdown anywhere in the
 * window, while this is how far below the running high we sit right now.
 */
function drawdownFromHigh(closes: number[], lookback = TRADING_DAYS_PER_YEAR): number | null {
  if (closes.length === 0) return null;
  const high = getMaximum(closes.slice(-lookback));
  if (high <= 0) return null;
  return ratioChange(high, closes[closes.length - 1]);
}

/** Total return between the latest close and the close `daysBack` sessions earlier. */
function totalReturn(closes: number[], daysBack: number): number | null {
  if (closes.length <= daysBack) return null;
  return ratioChange(closes[closes.length - 1 - daysBack], closes[closes.length - 1]);
}

/** Year-to-date return: from the first close of the current calendar year. */
function ytdReturn(bars: DailyBar[]): number | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const yr = last.date.getFullYear();
  const firstOfYear = bars.find((b) => b.date.getFullYear() === yr);
  if (!firstOfYear) return null;
  return ratioChange(firstOfYear.close, last.close);
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
  const volumes = bars.map((b) => b.volume);
  const price = closes[closes.length - 1] ?? null;

  // Moving averages — short, medium, long for both SMA and EMA
  const sma10  = finalValue(new SMA(10),  closes);
  const sma20  = finalValue(new SMA(20),  closes);
  const sma30  = finalValue(new SMA(30),  closes);
  const sma50  = finalValue(new SMA(50),  closes);
  const sma100 = finalValue(new SMA(100), closes);
  const sma200 = finalValue(new SMA(200), closes);
  const ema10  = finalValue(new EMA(10),  closes);
  const ema20  = finalValue(new EMA(20),  closes);
  const ema30  = finalValue(new EMA(30),  closes);
  const ema50  = finalValue(new EMA(50),  closes);
  const ema100 = finalValue(new EMA(100), closes);
  const ema200 = finalValue(new EMA(200), closes);

  const macd  = finalValue(new MACD(new EMA(12), new EMA(26), new EMA(9)), closes);
  const boll  = finalValue(new BollingerBands(20, 2), closes);
  const pctB  = finalValue(new PercentB({ deviationMultiplier: 2, interval: 20 }), closes);
  // ATR / CCI / Williams %R / Stochastic are candle indicators; DailyBar already
  // carries the high/low/close they read.
  const atr14 = finalValue(new ATR(14), bars);

  // Oscillators
  const rsi14      = finalValue(new RSI(14), closes);
  const stoch      = finalValue(new StochasticOscillator({ kPeriod: 14, kSlowingPeriod: 3, dPeriod: 3 }), bars);
  const williamsR14 = finalValue(new WilliamsR(14), bars);
  const cci20      = finalValue(new CCI(20), bars);
  const momentum10 = finalValue(new MOM(10), closes);

  const recent252 = closes.slice(-252);
  const high52 = recent252.length > 0 ? getMaximum(recent252) : null;
  const low52  = recent252.length > 0 ? getMinimum(recent252) : null;
  const position52WPct = price !== null && high52 !== null && low52 !== null && high52 > low52
    ? (price - low52) / (high52 - low52)
    : null;

  const avgVolume30 = volumes.length >= 30 ? getAverage(volumes.slice(-30)) : null;
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
    rsi14,
    macdLine:          macd?.macd ?? null,
    macdSignal:        macd?.signal ?? null,
    macdHistogram:     macd?.histogram ?? null,
    stochK14:          stoch?.stochK ?? null,
    stochD14:          stoch?.stochD ?? null,
    williamsR14,
    cci20,
    momentum10,
    // Bands & volatility
    bollingerUpper:    boll?.upper ?? null,
    bollingerMid:      boll?.middle ?? null,
    bollingerLower:    boll?.lower ?? null,
    bollingerPercentB: pctB,
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
