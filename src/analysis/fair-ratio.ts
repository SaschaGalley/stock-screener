/**
 * The multiple a stock's growth, margins and risk would normally earn.
 *
 * The history table says whether a stock is dearer than it used to be, the
 * industry columns whether it is dearer than its neighbours. Neither says
 * whether the premium is paid for: a company growing at 30 % on a 35 % margin
 * should trade above its industry's median, and by how much is the question.
 * This answers it the way the market does across the universe today — a
 * regression of each multiple, in logs, on revenue growth, operating and gross
 * margin, beta and the sector — and reads the stock's own inputs through it.
 *
 * Deliberately small: four inputs and a sector, inputs clipped to where the
 * universe actually lives. It is a yardstick, not a model of value — the R² travels
 * with every answer, and below a floor there is no answer.
 *
 * Dependency-free so the web app can import the types.
 */

export interface FairRatioInputs {
  revenueGrowth:   number | null;
  operatingMargin: number | null;
  grossMargin:     number | null;
  beta:            number | null;
  sector:          string | null;
}

export interface FairRatioRow extends FairRatioInputs {
  /** The multiple being explained — positive, or the row is left out. */
  multiple: number | null;
}

interface Feature { name: string; lo: number; hi: number; read: (x: FairRatioInputs) => number | null }

/** Each input, clipped to the range the universe actually spans. */
const FEATURES: Feature[] = [
  { name: 'revenueGrowth',   lo: -0.3, hi: 1.0, read: (x) => x.revenueGrowth },
  { name: 'operatingMargin', lo: -0.5, hi: 0.6, read: (x) => x.operatingMargin },
  { name: 'grossMargin',     lo: 0,    hi: 1.0, read: (x) => x.grossMargin },
  { name: 'beta',            lo: 0.3,  hi: 2.5, read: (x) => x.beta },
];

export interface FairRatioModel {
  coefficients: number[];
  /** Sector names in the order of their dummy columns; the first sector is the base. */
  sectors:      string[];
  r2:           number;
  n:            number;
  /** Means of the clipped features, for a stock missing one. */
  means:        number[];
}

/** Fewer stocks than this and the fit says more about noise than about the market. */
const MIN_ROWS = 60;
/** Below this the inputs explain too little for the answer to be worth showing. */
export const MIN_R2 = 0.2;
/**
 * A whisper of ridge on the slopes — enough that a degenerate column (a sector
 * whose members all share one margin) cannot break the solve, far too little
 * to bend the fit: margins vary by a few tenths, and a penalty of 1 shrank
 * their slope by a sixth.
 */
const RIDGE = 1e-4;

const clip = (v: number, f: Feature) => Math.min(f.hi, Math.max(f.lo, v));

function design(x: FairRatioInputs, model: { sectors: string[]; means: number[] }): number[] {
  const feats = FEATURES.map((f, k) => {
    const v = f.read(x);
    return v === null || !Number.isFinite(v) ? model.means[k] : clip(v, f);
  });
  const dummies = model.sectors.slice(1).map((s) => (x.sector === s ? 1 : 0));
  return [1, ...feats, ...dummies];
}

/** Solve (A + λI')β = b by Gaussian elimination; the intercept is not penalised. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

export function fitFairRatio(rows: FairRatioRow[]): FairRatioModel | null {
  // A row needs the multiple and at least growth and margin; beta and gross
  // margin may fall back to the universe's mean.
  const usable = rows.filter((r) => r.multiple !== null && r.multiple > 0 && Number.isFinite(r.multiple)
    && r.revenueGrowth !== null && r.operatingMargin !== null);
  if (usable.length < MIN_ROWS) return null;

  const means = FEATURES.map((f) => {
    const xs = usable.flatMap((r) => { const v = f.read(r); return v === null || !Number.isFinite(v) ? [] : [clip(v, f)]; });
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  });
  // A sector needs a few members to earn its own intercept.
  const counts = new Map<string, number>();
  for (const r of usable) if (r.sector) counts.set(r.sector, (counts.get(r.sector) ?? 0) + 1);
  const sectors = [...counts.entries()].filter(([, c]) => c >= 8).map(([s]) => s).sort();
  const base = { sectors, means };

  const X = usable.map((r) => design(r, base));
  // Logs: multiples are skewed, and a 10 % premium should mean the same at 5x as at 50x.
  const y = usable.map((r) => Math.log(r.multiple!));
  const p = X[0].length;
  const xtx = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) =>
    X.reduce((s, row) => s + row[i] * row[j], 0) + (i === j && i > 0 ? RIDGE : 0)));
  const xty = Array.from({ length: p }, (_, i) => X.reduce((s, row, k) => s + row[i] * y[k], 0));
  const beta = solve(xtx, xty);
  if (!beta) return null;

  const yHat = X.map((row) => row.reduce((s, v, i) => s + v * beta[i], 0));
  const yMean = y.reduce((a, b) => a + b, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = y.reduce((s, v, k) => s + (v - yHat[k]) ** 2, 0);
  return { coefficients: beta, sectors, means, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, n: usable.length };
}

/** The multiple the model expects for these inputs; null when the fit is too weak to say. */
export function fairMultiple(model: FairRatioModel, x: FairRatioInputs): number | null {
  if (model.r2 < MIN_R2) return null;
  const row = design(x, model);
  return Math.exp(row.reduce((s, v, i) => s + v * model.coefficients[i], 0));
}

/** What the service hands the page: the expected multiple and how much to trust it. */
export interface FairRatio {
  fair:   number;
  actual: number | null;
  r2:     number;
  n:      number;
  inputs: FairRatioInputs;
}
