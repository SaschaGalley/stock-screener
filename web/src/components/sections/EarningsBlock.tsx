import EarningsSurpriseChart from '../charts/EarningsSurpriseChart';
import ForwardGrowthChart from '../charts/ForwardGrowthChart';
import ForecastChart from '../charts/ForecastChart';
import { fmtSignedPct } from '../../format';
import { useMoney } from '../../currency';
import Term from '../Term';
import { AnswerCard, Question } from '../chart/shared';
import type { EarningsEstimate, EarningsSurprise } from '../../../../src/types';

interface Props {
  financials: any;
}

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const PERIOD: Record<string, string> = { '0q': 'dieses Quartal', '+1q': 'nächstes Quartal', '0y': 'dieses Jahr', '+1y': 'nächstes Jahr' };

/** Yahoo labels the quarters relative to today: "-1q" is the newest. */
const rank = (q: string) => Number(q.replace(/[^\d-]/g, '')) || 0;

/** "bis Jun 26" where the quarter's end is known, "vor 2 Quartalen" where only Yahoo's label is. */
export function quarterLabel(s: Pick<EarningsSurprise, 'quarter' | 'endDate'>): string {
  if (s.endDate) return `bis ${MON[Number(s.endDate.slice(5, 7)) - 1]} ${s.endDate.slice(2, 4)}`;
  const n = -rank(s.quarter);
  return n === 1 ? 'letztes Quartal' : n > 1 ? `vor ${n} Quartalen` : s.quarter;
}

const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;

/**
 * The quarters: whether the company beat what was expected of it, what is
 * expected next, and when — as three answers over the charts, the quarters
 * named by their month rather than by Yahoo's "-1q".
 */
export default function EarningsBlock({ financials: f }: Props) {
  const { fmtPrice, fmtBig } = useMoney();
  const past: EarningsSurprise[] = [...(f.earningsSurprises ?? [])].sort((a, b) => rank(a.quarter) - rank(b.quarter));
  const measured = past.filter((q) => q.surprisePct !== null);
  const beats = measured.filter((q) => q.surprisePct! > 0).length;
  const last = measured.at(-1);
  const meanSurprise = measured.length ? measured.reduce((s, q) => s + q.surprisePct!, 0) / measured.length : null;
  const est: EarningsEstimate[] = f.earningsEstimates ?? [];
  const year = est.find((e) => e.period === '0y');
  const next = est.find((e) => e.period === '+1y');
  const quarter = est.find((e) => e.period === '0q');

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-3">
        {measured.length > 0 && (
          <AnswerCard
            question="Hat sie die Erwartungen geschlagen?"
            answer={`${beats} von ${measured.length} Quartalen`}
            tone={beats === measured.length ? 'bull' : beats <= measured.length / 2 ? 'bear' : 'neutral'}
            why={[
              ...(last && last.epsActual !== null && last.epsEstimate !== null
                ? [`zuletzt (${quarterLabel(last)}) ${fmtPrice(last.epsActual)} je Aktie statt ${fmtPrice(last.epsEstimate)} erwartet, ${fmtSignedPct(last.surprisePct, 1)}`] : []),
              ...(meanSurprise !== null ? [`im Schnitt ${fmtSignedPct(meanSurprise, 1)} über oder unter der Schätzung`] : []),
            ]}
          />
        )}
        {(year || next) && (
          <AnswerCard
            question="Was erwarten die Analysten?"
            answer={year?.epsGrowth != null ? `Gewinn ${fmtSignedPct(year.epsGrowth, 0)} dieses Jahr` : next?.epsGrowth != null ? `Gewinn ${fmtSignedPct(next.epsGrowth, 0)} nächstes Jahr` : 'Keine Wachstumsschätzung'}
            tone={(year?.epsGrowth ?? next?.epsGrowth ?? 0) > 0.05 ? 'bull' : (year?.epsGrowth ?? next?.epsGrowth ?? 0) < 0 ? 'bear' : 'neutral'}
            why={[
              ...(year?.revenueGrowth != null ? [`Umsatz ${fmtSignedPct(year.revenueGrowth, 0)} dieses Jahr`] : []),
              ...(next?.epsGrowth != null && year?.epsGrowth != null ? [`nächstes Jahr Gewinn ${fmtSignedPct(next.epsGrowth, 0)}${next.revenueGrowth != null ? `, Umsatz ${fmtSignedPct(next.revenueGrowth, 0)}` : ''}`] : []),
            ]}
          />
        )}
        {(f.nextEarningsDate || quarter) && (
          <AnswerCard
            question="Wann kommen die nächsten Zahlen?"
            answer={f.nextEarningsDate ? `am ${dayDe(f.nextEarningsDate)}` : 'Termin unbekannt'}
            tone="neutral"
            why={quarter?.epsEstimate != null ? [
              `erwartet: ${fmtPrice(quarter.epsEstimate)} je Aktie${quarter.epsLow != null && quarter.epsHigh != null ? ` (Spanne ${fmtPrice(quarter.epsLow)}–${fmtPrice(quarter.epsHigh)})` : ''}`,
              ...(quarter.revenueEstimate ? [`Umsatz ${fmtBig(quarter.revenueEstimate)}`] : []),
            ] : []}
          />
        )}
      </div>

      {f.fundamentalsHistory && (
        <ForecastChart history={f.fundamentalsHistory} estimates={est} />
      )}

      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        {past.length > 0 && (
          <div>
            <Question note="Gewinn je Aktie gegen die Schätzung davor"><Term k="concept.surprises">Die letzten vier Quartale</Term></Question>
            <div className="rounded border border-ink-800 bg-ink-950 p-2" style={{ height: 180 }}>
              <EarningsSurpriseChart surprises={past.map((q) => ({ ...q, quarter: quarterLabel(q) }))} />
            </div>
            <table className="mt-2 w-full text-sm tabular">
              <thead>
                <tr className="border-b border-ink-800 text-xs text-ink-500">
                  <th className="py-1 pr-2 text-left font-normal">Quartal</th>
                  <th className="py-1 px-2 text-right font-normal">erwartet</th>
                  <th className="py-1 px-2 text-right font-normal">berichtet</th>
                  <th className="py-1 pl-2 text-right font-normal"><Term k="concept.surprisePct">Überraschung</Term></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {[...past].reverse().map((q, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-2 text-ink-300">{quarterLabel(q)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-ink-400">{q.epsEstimate !== null ? fmtPrice(q.epsEstimate) : '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-ink-100">{q.epsActual !== null ? fmtPrice(q.epsActual) : '—'}</td>
                    <td className={`py-1.5 pl-2 text-right ${q.surprisePct == null ? 'text-ink-500' : q.surprisePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {q.surprisePct == null ? '—' : `${fmtSignedPct(q.surprisePct, 1)} ${q.surprisePct >= 0 ? 'besser' : 'schlechter'}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {est.length > 0 && (
          <div>
            <Question note="Mittel der Analystenschätzungen"><Term k="concept.forwardEstimates">Was für die nächsten Perioden erwartet wird</Term></Question>
            <div className="rounded border border-ink-800 bg-ink-950 p-2" style={{ height: 180 }}>
              <ForwardGrowthChart estimates={est} />
            </div>
            <table className="mt-2 w-full text-sm tabular">
              <thead>
                <tr className="border-b border-ink-800 text-xs text-ink-500">
                  <th className="py-1 pr-2 text-left font-normal" />
                  <th className="py-1 px-2 text-right font-normal">Gewinn je Aktie</th>
                  <th className="py-1 px-2 text-right font-normal">Umsatz</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {est.map((e, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-ink-300">{PERIOD[e.period] ?? e.period}</td>
                    <td className="whitespace-nowrap py-1.5 px-2 text-right">
                      <span className="font-mono text-ink-100">{e.epsEstimate ? fmtPrice(e.epsEstimate) : '—'}</span>
                      {e.epsGrowth != null && <span className={`ml-2 text-xs ${e.epsGrowth > 0 ? 'text-emerald-400' : e.epsGrowth < 0 ? 'text-red-400' : 'text-ink-500'}`}>{fmtSignedPct(e.epsGrowth, 0)}</span>}
                    </td>
                    <td className="whitespace-nowrap py-1.5 px-2 text-right">
                      <span className="font-mono text-ink-100">{e.revenueEstimate ? fmtBig(e.revenueEstimate) : '—'}</span>
                      {e.revenueGrowth != null && <span className={`ml-2 text-xs ${e.revenueGrowth > 0 ? 'text-emerald-400' : e.revenueGrowth < 0 ? 'text-red-400' : 'text-ink-500'}`}>{fmtSignedPct(e.revenueGrowth, 0)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-ink-500">Prozente: Veränderung gegen dieselbe Periode im Vorjahr.</p>
          </div>
        )}
      </div>
    </div>
  );
}
