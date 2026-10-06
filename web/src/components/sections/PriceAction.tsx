import ReturnsChart from '../charts/ReturnsChart';
import { fmt, fmtPct, fmtSignedPct } from '../../format';
import Term from '../Term';
import type { GlossaryKey } from '../../glossary';

interface Props {
  marketSignals: any;
}

/**
 * Pure price-action context — what has the stock DONE? Returns over time,
 * volatility, position relative to peaks, and relative strength vs the
 * benchmarks. Deliberately excludes momentum indicators (RSI, MACD, MAs)
 * since those live in the chart section above.
 */
export default function PriceAction({ marketSignals: ms }: Props) {
  const t = ms?.technicals;
  if (!t) return <p className="text-xs text-ink-500">Keine Kursdaten.</p>;

  return (
    <div className="space-y-4">
      {t.returns && (
        <div>
          <h3 className="mb-2 text-xs font-semibold text-ink-300">
            <Term k="concept.trailingReturns">Renditen</Term>
          </h3>
          <div className="rounded border border-ink-700 bg-ink-950 p-2" style={{ height: 180 }}>
            <ReturnsChart returns={t.returns} />
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Block title="Schwankung">
          <Row label="ATR (14)"   term="signals.technicals.atr14Pct" value={fmtPct(t.atr14Pct)}        accent="vom Kurs" />
          <Row label="HV 30"      term="signals.technicals.hv30" value={fmtPct(t.hv30)}            accent="p. a." />
          <Row label="HV 90"      term="signals.technicals.hv90" value={fmtPct(t.hv90)}            accent="p. a." />
          <Row label="Beta (5 J)"  term="financials.beta" value={fmt(t.beta, '', 2)} />
        </Block>

        <Block title="Lage">
          <Row label="Abstand zum Jahreshoch" term="signals.technicals.drawdownFromHighPct" value={fmtSignedPct(t.drawdownFromHighPct)}
            accentColor={t.drawdownFromHighPct == null ? undefined : t.drawdownFromHighPct <= -0.2 ? 'text-red-400' : t.drawdownFromHighPct <= -0.1 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="In der 52-Wochen-Spanne" term="signals.technicals.position52WPct" value={fmtPct(t.position52WPct)}
            accent={t.position52WPct >= 0.9 ? 'nahe Hoch' : t.position52WPct <= 0.1 ? 'nahe Tief' : 'Mitte'} />
          <Row label="Volumen" term="signals.technicals.currentVolRatio" value={fmt(t.currentVolRatio, 'x', 2)}
            accent="vs. Ø 30 T" />
        </Block>

        <Block title="Relative Stärke (3 M)">
          <Row label="vs. S&P 500"        term="signals.technicals.rsVsSPY3M" value={fmtSignedPct(t.rsVsSPY3M)}
            accentColor={(t.rsVsSPY3M ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} />
          <Row label="vs. Sektor-ETF" term="signals.technicals.rsVsSector3M" value={fmtSignedPct(t.rsVsSector3M)}
            accentColor={(t.rsVsSector3M ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        </Block>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">{title}</h3>
      <table className="w-full text-xs tabular">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ label, term, value, accent, accentColor }: {
  label: string; term?: GlossaryKey; value: string; accent?: string; accentColor?: string;
}) {
  return (
    <tr className="border-b border-ink-800">
      <td className="py-1 pr-2 text-ink-400"><Term k={term}>{label}</Term></td>
      <td className={`py-1 text-right font-mono ${accentColor ?? 'text-ink-100'}`}>{value}</td>
      {accent !== undefined && (
        <td className="py-1 pl-2 text-right text-2xs text-ink-500">{accent}</td>
      )}
    </tr>
  );
}
