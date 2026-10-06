import { trendTable, type AnnualHistory } from '../../../../src/analysis/trends';
import Term from '../Term';
import Tip from '../Tip';
import { GLOSSARY, TREND_TERMS } from '../../glossary';
import { deNumber, fmtPct } from '../../format';

/** Below this, a move against the prior years is noise rather than a trend. */
const FLAT = 0.01;

/**
 * Margins and returns: the latest fiscal year against its own past.
 *
 * The grid underneath shows today's margins; this says whether they are the
 * company's normal. The arrow compares the latest year with the mean of the
 * years before it, and every ratio here reads "higher is better", so green
 * always means improving.
 */
export default function MarginTrends({ history }: { history: AnnualHistory }) {
  const rows = trendTable(history);
  if (rows.length === 0) return null;
  const latestYear = Math.max(...rows.map((r) => r.summary.latest?.year ?? 0));
  // Yahoo usually reports four fiscal years, not five; the header says which.
  const years = Math.max(...rows.map((r) => r.summary.years));

  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">
        <Term k="concept.marginTrends">Margen &amp; Renditen im Verlauf</Term>
      </h3>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-700 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-normal" />
            <th className="py-1 text-right font-normal">GJ {latestYear}</th>
            <th className="py-1 text-right font-normal">Ø 3J</th>
            <th className="py-1 text-right font-normal">Ø {years}J</th>
            <th className="w-5 py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, label, series, summary }) => {
            const d = summary.vsPrior;
            const trend = d === null || Math.abs(d) < FLAT ? null : d > 0 ? 'up' : 'down';
            return (
              <tr
                key={key}
                className="border-b border-ink-800"
                title={series.map((p) => `${p.year}: ${pct(p.value)}`).join('\n')}
              >
                <td className="py-1 pr-2 text-ink-400"><Term k={TREND_TERMS[key]}>{label}</Term></td>
                <td className="py-1 text-right font-mono text-ink-100">{pct(summary.latest?.value ?? null)}</td>
                <td className="py-1 text-right font-mono text-ink-300">{pct(summary.avg3)}</td>
                <td className="py-1 text-right font-mono text-ink-400">{pct(summary.avgAll)}</td>
                <td className={`py-1 text-right font-mono ${trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-red-400' : 'text-ink-600'}`}>
                  <Tip
                    focusable={false}
                    content={
                      <>
                        {d !== null && <div>{d >= 0 ? '+' : '−'}{deNumber(Math.abs(d) * 100, 1)} Prozentpunkte gegenüber dem Schnitt der Vorjahre.</div>}
                        <div className="mt-1 text-ink-400">{GLOSSARY['concept.trendArrow']}</div>
                      </>
                    }
                  >
                    {trend === 'up' ? '▲' : trend === 'down' ? '▼' : '·'}
                  </Tip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1.5 text-xs text-ink-500">
        Geschäftsjahre, nicht TTM. Der Pfeil vergleicht das letzte Jahr mit dem Schnitt der Jahre davor.
      </p>
    </div>
  );
}

function pct(v: number | null): string {
  return fmtPct(v, 1);
}
