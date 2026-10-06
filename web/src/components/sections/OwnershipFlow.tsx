import { useMoney } from '../../currency';
import { deNumber, fmtPct, fmtPercentPoints } from '../../format';
import Term from '../Term';
import type { GlossaryKey } from '../../glossary';

interface Props {
  financials: any;
}

export default function OwnershipFlow({ financials: f }: Props) {
  const { fmtBig, fmtCount } = useMoney();
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Short interest */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-ink-300">Short Interest</h3>
        {f.shortPercentOfFloat != null && Number.isFinite(f.shortPercentOfFloat) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              <Row label="% of Float" term="financials.shortPercentOfFloat" value={fmtPct(f.shortPercentOfFloat, 1)}
                accentColor={f.shortPercentOfFloat > 0.20 ? 'text-red-400' : f.shortPercentOfFloat > 0.08 ? 'text-amber-400' : 'text-emerald-400'} />
              <Row label="Shares Short"  term="financials.sharesShort" value={fmtCount(f.sharesShort)} />
              <Row label="Days to Cover" term="financials.shortRatio" value={f.shortRatio != null && Number.isFinite(f.shortRatio) ? deNumber(f.shortRatio, 1) + 'd' : '—'} />
              {f.sharesShort != null && f.sharesShortPriorMonth != null && f.sharesShortPriorMonth > 0 && (() => {
                const chg = (f.sharesShort - f.sharesShortPriorMonth) / f.sharesShortPriorMonth * 100;
                return <Row label="MoM" term="concept.shortMoM" value={fmtPercentPoints(chg, 0)}
                  accentColor={chg >= 0 ? 'text-red-400' : 'text-emerald-400'} />;
              })()}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">No short interest data.</p>}
      </div>

      {/* Ownership */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-ink-300">Ownership</h3>
        {(f.institutionsPercentHeld != null || f.insidersPercentHeld != null) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              {f.institutionsPercentHeld != null && Number.isFinite(f.institutionsPercentHeld) && (
                <Row label="Institutions" term="financials.institutionsPercentHeld"
                  value={fmtPct(f.institutionsPercentHeld, 1)}
                  accent={f.institutionsCount ? `${f.institutionsCount.toLocaleString('de-DE')} holders` : ''} />
              )}
              {f.insidersPercentHeld != null && Number.isFinite(f.insidersPercentHeld) && (
                <Row label="Insiders" term="financials.insidersPercentHeld" value={fmtPct(f.insidersPercentHeld, 1)} />
              )}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">No ownership data.</p>}
      </div>

      {/* Insider activity */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-ink-300">
          <Term k="concept.insiderActivity">Insider Activity</Term> <span className="text-ink-500">(6mo)</span>
        </h3>
        {(f.insiderBuyCount > 0 || f.insiderSellCount > 0) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              {f.insiderBuyCount > 0 && (
                <Row
                  label="Buys"
                  value={`${f.insiderBuyCount} txn`}
                  accent={`+${f.insiderBuyShares?.toLocaleString('de-DE') ?? 0} sh / ${fmtBig(f.insiderBuyValue)}`}
                  accentColor="text-emerald-400"
                />
              )}
              {f.insiderSellCount > 0 && (
                <Row
                  label="Sells"
                  value={`${f.insiderSellCount} txn`}
                  accent={`−${f.insiderSellShares?.toLocaleString('de-DE') ?? 0} sh / ${fmtBig(f.insiderSellValue)}`}
                  accentColor="text-red-400"
                />
              )}
              {f.insiderBuyCount > 0 && f.insiderSellCount > 0 && (() => {
                const netSh = (f.insiderBuyShares ?? 0) - (f.insiderSellShares ?? 0);
                const netVal = (f.insiderBuyValue ?? 0) - (f.insiderSellValue ?? 0);
                return <Row label="Net" value={`${netSh >= 0 ? '+' : ''}${deNumber(netSh, 0)} sh`}
                  accent={fmtBig(netVal)}
                  accentColor={netSh >= 0 ? 'text-emerald-400' : 'text-red-400'} />;
              })()}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">No recent transactions.</p>}
      </div>
    </div>
  );
}

function Row({ label, term, value, accent, accentColor }: { label: string; term?: GlossaryKey; value: string; accent?: string; accentColor?: string }) {
  return (
    <tr className="border-b border-ink-800">
      <td className="py-1 pr-2 text-ink-400"><Term k={term}>{label}</Term></td>
      <td className={`py-1 text-right font-mono ${accentColor ?? 'text-ink-100'}`}>{value}</td>
      {accent !== undefined && <td className="py-1 pl-2 text-right text-2xs text-ink-500">{accent}</td>}
    </tr>
  );
}
