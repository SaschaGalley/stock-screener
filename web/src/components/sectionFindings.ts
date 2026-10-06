/**
 * What each section of the stock page finds, in one line for its header.
 *
 * A header used to say what the section holds — "DCF, peer multiples,
 * reverse DCF" — which is what its title and ⓘ already say. It says what
 * the section found now, so a reader can tell from the header whether the
 * body is worth reading. These are the sections whose data the page already
 * has; the ones that load their own report through `useSectionFinding`.
 *
 * Each returns null when it has nothing to say, and the subtitle stays.
 */

import type { ComputedMetrics, StockFinancials } from '../types';
import type { SectorMedians } from '../../../src/types';

type Fmt = (n: number | null | undefined) => string;

const de = (x: number, d = 1) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const ok = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
const pct = (x: number, d = 0) => `${x >= 0 ? '+' : '−'}${de(Math.abs(x * 100), d)} %`;
const share = (x: number, d = 0) => `${de(x * 100, d)} %`;
const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`;
const join = (parts: (string | null | false | undefined)[]) => {
  const s = parts.filter(Boolean).join(' · ');
  return s || null;
};

/** "12 % unter dem Kurs" — where a value stands against today's price. */
export function againstPrice(value: number, price: number): string {
  const d = value / price - 1;
  if (Math.abs(d) < 0.005) return 'auf Kurshöhe';
  return `${de(Math.abs(d * 100), 0)} % ${d > 0 ? 'über' : 'unter'} dem Kurs`;
}

export function fairValueFinding(m: ComputedMetrics, price: number, fmt: Fmt): string | null {
  const p = m.composite.primary, c = m.composite.conservative;
  if (!ok(p.median) || !(price > 0)) return null;
  return join([
    `Fairer Wert ${fmt(p.median)}, ${againstPrice(p.median, price)}`,
    ok(p.min) && ok(p.max) && `Modelle ${fmt(p.min)}–${fmt(p.max)}`,
    ok(c.median) && `konservativ ${fmt(c.median)}`,
  ]);
}

export function modelsFinding(m: ComputedMetrics, price: number, fmt: Fmt): string | null {
  const r = m.reverseDCF;
  return join([
    ok(m.dcf.fairValue) && price > 0 && `DCF ${fmt(m.dcf.fairValue)}, ${againstPrice(m.dcf.fairValue, price)}`,
    r.isPossible && ok(r.impliedGrowthRate) && `der Kurs verlangt ${pct(r.impliedGrowthRate)} Umsatzwachstum${ok(r.consensusGrowth) ? `, Konsens ${pct(r.consensusGrowth)}` : ''}`,
  ]);
}

export function peersFinding(m: ComputedMetrics, sector: SectorMedians | null): string | null {
  if (!sector) return null;
  const vs = (label: string, own: number | null | undefined, peers: number | null | undefined) =>
    ok(own) && ok(peers) && own > 0 && peers > 0 && `${label} ${de(own)} gegen ${de(peers)}`;
  const s = join([
    vs('KGV', m.ratios.pe, sector.pe),
    vs('EV/EBITDA', m.evMultiples.evToEbitda, sector.evToEbitda),
    ok(m.ratios.operatingMargin) && ok(sector.operatingMargin) && `Marge ${share(m.ratios.operatingMargin)} gegen ${share(sector.operatingMargin)}`,
  ]);
  return s && `${s} bei den Peers`;
}

export function fundamentalsFinding(f: StockFinancials, m: ComputedMetrics): string | null {
  return join([
    ok(f.revenueGrowth) && `Umsatz ${pct(f.revenueGrowth)}`,
    ok(f.operatingMargin) && `operative Marge ${share(f.operatingMargin)}`,
    ok(m.ratios.netMargin) && `Nettomarge ${share(m.ratios.netMargin)}`,
    ok(f.roic) && `ROIC ${share(f.roic)}`,
  ]);
}

export function earningsFinding(f: StockFinancials): string | null {
  // Yahoo labels the quarters relative to today: "-1q" is the newest.
  const rank = (q: string) => Number(q.replace(/[^\d-]/g, '')) || 0;
  const past = [...(f.earningsSurprises ?? [])].filter((e) => ok(e.surprisePct)).sort((a, b) => rank(b.quarter) - rank(a.quarter));
  const last = past[0];
  const beats = past.filter((e) => e.surprisePct! > 0).length;
  return join([
    last && ok(last.epsActual) && ok(last.epsEstimate)
      && `zuletzt EPS ${de(last.epsActual, 2)} gegen ${de(last.epsEstimate, 2)} erwartet (${pct(last.surprisePct!)})`,
    past.length > 1 && `${beats} von ${past.length} Quartalen übertroffen`,
    f.nextEarningsDate && `nächste Zahlen ${dayDe(f.nextEarningsDate)}`,
  ]);
}

const ALTMAN_ZONE = { safe: 'sicher', grey: 'Grauzone', distress: 'gefährdet', unknown: null } as const;
const BENEISH = { 'likely manipulator': 'Beneish auffällig', 'grey zone': 'Beneish Grauzone', 'unlikely manipulator': 'Beneish unauffällig', unknown: null } as const;

export function qualityFinding(m: ComputedMetrics): string | null {
  const checks = m.health.checks;
  const passed = checks.filter((c) => c.mark === 'pass').length;
  return join([
    checks.length > 0 && `Bilanz: ${passed} von ${checks.length} Prüfungen bestanden`,
    ok(m.piotroski.score) && `Piotroski ${m.piotroski.score}/9`,
    ok(m.altmanZ.score) && `Altman-Z ${de(m.altmanZ.score)}${ALTMAN_ZONE[m.altmanZ.zone] ? ` (${ALTMAN_ZONE[m.altmanZ.zone]})` : ''}`,
    BENEISH[m.beneish.probability],
  ]);
}

export function ownershipFinding(f: StockFinancials, fmtBig: Fmt): string | null {
  const buy = f.insiderBuyValue ?? 0, sell = f.insiderSellValue ?? 0;
  const insiders = buy === 0 && sell === 0 ? null
    : buy > sell ? `Insider kauften netto ${fmtBig(buy - sell)} in 6 M` : `Insider verkauften netto ${fmtBig(sell - buy)} in 6 M`;
  return join([
    ok(f.institutionsPercentHeld) && `Institutionen ${share(f.institutionsPercentHeld)}`,
    insiders,
    ok(f.shortPercentOfFloat) && `leerverkauft ${share(f.shortPercentOfFloat, 1)}`,
  ]);
}

export function researchFinding(news: { datetime: number }[], perplexity: { fetchedAt: string } | null, deep: { fetchedAt: string } | null): string | null {
  const day = (iso: string) => dayDe(iso.slice(0, 10));
  return join([
    perplexity && `Perplexity vom ${day(perplexity.fetchedAt)}`,
    deep && `Deep Research vom ${day(deep.fetchedAt)}`,
    news.length > 0 && `${news.length} Meldungen`,
  ]);
}
