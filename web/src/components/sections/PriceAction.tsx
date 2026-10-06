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
  if (!t) return <p className="text-xs text-ink-500">No price data.</p>;

  return (
    <div className="space-y-4">
      {t.returns && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">
            <Term k="concept.trailingReturns">Trailing Returns</Term>
          </h3>
          <div className="rounded border border-ink-700 bg-ink-950 p-2" style={{ height: 180 }}>
            <ReturnsChart returns={t.returns} />
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Block title="Volatility">
          <Row label="ATR (14)"   term="signals.technicals.atr14Pct" value={fmtPct(t.atr14Pct)}        accent="of price" />
          <Row label="HV 30"      term="signals.technicals.hv30" value={fmtPct(t.hv30)}            accent="annualised" />
          <Row label="HV 90"      term="signals.technicals.hv90" value={fmtPct(t.hv90)}            accent="annualised" />
          <Row label="Beta (5Y)"  term="financials.beta" value={fmt(t.beta, '', 2)} />
        </Block>

        <Block title="Position">
          <Row label="Drawdown from 1Y high" term="signals.technicals.drawdownFromHighPct" value={fmtSignedPct(t.drawdownFromHighPct)}
            accentColor={t.drawdownFromHighPct == null ? undefined : t.drawdownFromHighPct <= -0.2 ? 'text-red-400' : t.drawdownFromHighPct <= -0.1 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="52W range" term="signals.technicals.position52WPct" value={fmtPct(t.position52WPct)}
            accent={t.position52WPct >= 0.9 ? 'near high' : t.position52WPct <= 0.1 ? 'near low' : 'mid'} />
          <Row label="Volume ratio" term="signals.technicals.currentVolRatio" value={fmt(t.currentVolRatio, 'x', 2)}
            accent="vs 30d avg" />
        </Block>

        <Block title="Relative Strength (3M)">
          <Row label="vs SPY"        term="signals.technicals.rsVsSPY3M" value={fmtSignedPct(t.rsVsSPY3M)}
            accentColor={(t.rsVsSPY3M ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} />
          <Row label="vs Sector ETF" term="signals.technicals.rsVsSector3M" value={fmtSignedPct(t.rsVsSector3M)}
            accentColor={(t.rsVsSector3M ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        </Block>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
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
