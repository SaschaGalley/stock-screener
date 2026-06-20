import {
  SignalDirection, SignalGroup, SignalItem, TechnicalIndicators, TechnicalSignals,
} from '../types.js';

// ─── Classification rules ─────────────────────────────────────────────────────
// Mirrors TradingView's standard "Technical Analysis Summary" voting logic.
// Each indicator votes buy / sell / neutral. We aggregate to a score in [-1, 1]
// and a verdict bucket (STRONG SELL → STRONG BUY).

const FLAT_TOLERANCE = 0.001; // 0.1% — price/MA differences below this count as neutral

function classifyMA(price: number, ma: number | null | undefined): SignalDirection {
  if (ma == null || !Number.isFinite(ma) || ma === 0) return 'neutral';
  const diff = (price - ma) / ma;
  if (diff > FLAT_TOLERANCE)  return 'buy';
  if (diff < -FLAT_TOLERANCE) return 'sell';
  return 'neutral';
}

function isUsable(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

function classifyRSI(rsi: number | null | undefined): SignalDirection {
  if (!isUsable(rsi)) return 'neutral';
  if (rsi <= 30) return 'buy';
  if (rsi >= 70) return 'sell';
  return 'neutral';
}

function classifyStochastic(k: number | null | undefined, d: number | null | undefined): SignalDirection {
  if (!isUsable(k) || !isUsable(d)) return 'neutral';
  // Canonical: in oversold territory a %K crossing UP through %D (k >= d) is the
  // buy turn-up; in overbought territory a %K crossing DOWN through %D (k <= d)
  // is the sell turn-down. The operators were previously inverted.
  if (k < 20 && k >= d) return 'buy';
  if (k > 80 && k <= d) return 'sell';
  return 'neutral';
}

function classifyMACD(line: number | null | undefined, signal: number | null | undefined): SignalDirection {
  if (!isUsable(line) || !isUsable(signal)) return 'neutral';
  if (line > signal) return 'buy';
  if (line < signal) return 'sell';
  return 'neutral';
}

function classifyCCI(cci: number | null | undefined): SignalDirection {
  if (!isUsable(cci)) return 'neutral';
  if (cci < -100) return 'buy';
  if (cci >  100) return 'sell';
  return 'neutral';
}

function classifyWilliamsR(wr: number | null | undefined): SignalDirection {
  if (!isUsable(wr)) return 'neutral';
  if (wr <= -80) return 'buy';
  if (wr >= -20) return 'sell';
  return 'neutral';
}

function classifyMomentum(mom: number | null | undefined): SignalDirection {
  if (!isUsable(mom)) return 'neutral';
  if (mom > 0) return 'buy';
  if (mom < 0) return 'sell';
  return 'neutral';
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function verdictFromScore(score: number): SignalGroup['verdict'] {
  if (score >=  0.5) return 'STRONG BUY';
  if (score >=  0.1) return 'BUY';
  if (score <= -0.5) return 'STRONG SELL';
  if (score <= -0.1) return 'SELL';
  return 'NEUTRAL';
}

function tally(items: SignalItem[]): SignalGroup {
  let buy = 0, sell = 0, neutral = 0;
  for (const it of items) {
    if (it.signal === 'buy')  buy++;
    else if (it.signal === 'sell') sell++;
    else neutral++;
  }
  const total = items.length;
  const score = total === 0 ? 0 : (buy - sell) / total;
  return { items, buy, sell, neutral, score, verdict: verdictFromScore(score) };
}

function maItem(name: string, price: number, ma: number | null | undefined): SignalItem {
  const sig = classifyMA(price, ma);
  const usable = ma != null && Number.isFinite(ma);
  const hint = !usable
    ? 'insufficient history'
    : `price ${price.toFixed(2)} ${sig === 'buy' ? '>' : sig === 'sell' ? '<' : '≈'} ${name} ${ma!.toFixed(2)}`;
  return { name, value: usable ? (ma as number) : null, signal: sig, hint };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function deriveTechnicalSignals(t: TechnicalIndicators, price: number): TechnicalSignals {
  // Moving averages — 12 entries (SMA + EMA × {10,20,30,50,100,200})
  const maItems: SignalItem[] = [
    maItem('SMA 10',  price, t.sma10),
    maItem('SMA 20',  price, t.sma20),
    maItem('SMA 30',  price, t.sma30),
    maItem('SMA 50',  price, t.sma50),
    maItem('SMA 100', price, t.sma100),
    maItem('SMA 200', price, t.sma200),
    maItem('EMA 10',  price, t.ema10),
    maItem('EMA 20',  price, t.ema20),
    maItem('EMA 30',  price, t.ema30),
    maItem('EMA 50',  price, t.ema50),
    maItem('EMA 100', price, t.ema100),
    maItem('EMA 200', price, t.ema200),
  ];

  // Oscillators — 7 entries. Each value tolerated as null OR undefined OR NaN
  // (older cached signals shapes might be missing fields).
  const safe = (n: number | null | undefined): number | null => isUsable(n) ? n : null;

  const oscItems: SignalItem[] = [
    {
      name: 'RSI (14)', value: safe(t.rsi14), signal: classifyRSI(t.rsi14),
      hint: !isUsable(t.rsi14) ? 'n/a'
        : t.rsi14 >= 70 ? `${t.rsi14.toFixed(1)} ≥ 70 → overbought`
        : t.rsi14 <= 30 ? `${t.rsi14.toFixed(1)} ≤ 30 → oversold`
        : `${t.rsi14.toFixed(1)} in 30–70 → neutral`,
    },
    {
      name: 'Stochastic %K (14)', value: safe(t.stochK14), signal: classifyStochastic(t.stochK14, t.stochD14),
      hint: !isUsable(t.stochK14) || !isUsable(t.stochD14) ? 'n/a'
        : `%K ${t.stochK14.toFixed(1)} vs %D ${t.stochD14.toFixed(1)} (oversold <20, overbought >80)`,
    },
    {
      name: 'MACD (12,26,9)', value: safe(t.macdHistogram), signal: classifyMACD(t.macdLine, t.macdSignal),
      hint: !isUsable(t.macdLine) || !isUsable(t.macdSignal) ? 'n/a'
        : `line ${t.macdLine.toFixed(2)} ${t.macdLine > t.macdSignal ? '>' : t.macdLine < t.macdSignal ? '<' : '='} signal ${t.macdSignal.toFixed(2)}`,
    },
    {
      name: 'CCI (20)', value: safe(t.cci20), signal: classifyCCI(t.cci20),
      hint: !isUsable(t.cci20) ? 'n/a'
        : t.cci20 > 100 ? `${t.cci20.toFixed(1)} > 100 → overbought`
        : t.cci20 < -100 ? `${t.cci20.toFixed(1)} < −100 → oversold`
        : `${t.cci20.toFixed(1)} in ±100 → neutral`,
    },
    {
      name: 'Williams %R (14)', value: safe(t.williamsR14), signal: classifyWilliamsR(t.williamsR14),
      hint: !isUsable(t.williamsR14) ? 'n/a'
        : t.williamsR14 <= -80 ? `${t.williamsR14.toFixed(1)} ≤ −80 → oversold`
        : t.williamsR14 >= -20 ? `${t.williamsR14.toFixed(1)} ≥ −20 → overbought`
        : `${t.williamsR14.toFixed(1)} in −80…−20 → neutral`,
    },
    {
      name: 'Momentum (10)', value: safe(t.momentum10), signal: classifyMomentum(t.momentum10),
      hint: !isUsable(t.momentum10) ? 'n/a'
        : `${t.momentum10 > 0 ? 'positive' : t.momentum10 < 0 ? 'negative' : 'flat'} (${t.momentum10.toFixed(2)})`,
    },
    {
      name: 'Bollinger %B', value: safe(t.bollingerPercentB),
      signal: !isUsable(t.bollingerPercentB) ? 'neutral'
        : t.bollingerPercentB < 0 ? 'buy'
        : t.bollingerPercentB > 1 ? 'sell'
        : 'neutral',
      hint: !isUsable(t.bollingerPercentB) ? 'n/a'
        : t.bollingerPercentB < 0 ? `${t.bollingerPercentB.toFixed(2)} < 0 → below lower band`
        : t.bollingerPercentB > 1 ? `${t.bollingerPercentB.toFixed(2)} > 1 → above upper band`
        : `${t.bollingerPercentB.toFixed(2)} in band`,
    },
  ];

  const movingAverages = tally(maItems);
  const oscillators    = tally(oscItems);

  // TradingView-style summary: equal-weight the two GROUP scores instead of
  // pooling all votes, otherwise the 12 MA votes swamp the 7 oscillator votes
  // (~63/37) and pin the verdict to the trend in any trending market.
  const groups = [movingAverages, oscillators].filter((g) => g.items.length > 0);
  const overallScore = groups.length ? groups.reduce((s, g) => s + g.score, 0) / groups.length : 0;
  const overall: SignalGroup = {
    items:   [...maItems, ...oscItems],
    buy:     movingAverages.buy + oscillators.buy,
    sell:    movingAverages.sell + oscillators.sell,
    neutral: movingAverages.neutral + oscillators.neutral,
    score:   overallScore,
    verdict: verdictFromScore(overallScore),
  };

  return { movingAverages, oscillators, overall };
}
