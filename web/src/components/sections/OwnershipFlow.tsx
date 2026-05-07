import { fmtBig } from '../../format';

interface Props {
  financials: any;
}

export default function OwnershipFlow({ financials: f }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Short interest */}
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">Short Interest</h3>
        {f.shortPercentOfFloat != null && Number.isFinite(f.shortPercentOfFloat) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              <Row label="% of Float" value={`${(f.shortPercentOfFloat * 100).toFixed(1)}%`}
                accentColor={f.shortPercentOfFloat > 0.20 ? 'text-red-400' : f.shortPercentOfFloat > 0.08 ? 'text-amber-400' : 'text-emerald-400'} />
              <Row label="Shares Short"  value={f.sharesShort != null ? fmtBig(f.sharesShort).replace('$', '') : '—'} />
              <Row label="Days to Cover" value={f.shortRatio != null && Number.isFinite(f.shortRatio) ? f.shortRatio.toFixed(1) + 'd' : '—'} />
              {f.sharesShort != null && f.sharesShortPriorMonth != null && f.sharesShortPriorMonth > 0 && (() => {
                const chg = (f.sharesShort - f.sharesShortPriorMonth) / f.sharesShortPriorMonth * 100;
                return <Row label="MoM" value={`${chg >= 0 ? '+' : ''}${chg.toFixed(0)}%`}
                  accentColor={chg >= 0 ? 'text-red-400' : 'text-emerald-400'} />;
              })()}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">No short interest data.</p>}
      </div>

      {/* Ownership */}
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">Ownership</h3>
        {(f.institutionsPercentHeld != null || f.insidersPercentHeld != null) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              {f.institutionsPercentHeld != null && Number.isFinite(f.institutionsPercentHeld) && (
                <Row label="Institutions"
                  value={`${(f.institutionsPercentHeld * 100).toFixed(1)}%`}
                  accent={f.institutionsCount ? `${f.institutionsCount.toLocaleString()} holders` : ''} />
              )}
              {f.insidersPercentHeld != null && Number.isFinite(f.insidersPercentHeld) && (
                <Row label="Insiders" value={`${(f.insidersPercentHeld * 100).toFixed(1)}%`} />
              )}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">No ownership data.</p>}
      </div>

      {/* Insider activity */}
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Insider Activity <span className="text-ink-600">(6mo)</span>
        </h3>
        {(f.insiderBuyCount > 0 || f.insiderSellCount > 0) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              {f.insiderBuyCount > 0 && (
                <Row
                  label="Buys"
                  value={`${f.insiderBuyCount} txn`}
                  accent={`+${f.insiderBuyShares?.toLocaleString() ?? 0} sh / ${fmtBig(f.insiderBuyValue)}`}
                  accentColor="text-emerald-400"
                />
              )}
              {f.insiderSellCount > 0 && (
                <Row
                  label="Sells"
                  value={`${f.insiderSellCount} txn`}
                  accent={`-${f.insiderSellShares?.toLocaleString() ?? 0} sh / ${fmtBig(f.insiderSellValue)}`}
                  accentColor="text-red-400"
                />
              )}
              {f.insiderBuyCount > 0 && f.insiderSellCount > 0 && (() => {
                const netSh = (f.insiderBuyShares ?? 0) - (f.insiderSellShares ?? 0);
                const netVal = (f.insiderBuyValue ?? 0) - (f.insiderSellValue ?? 0);
                return <Row label="Net" value={`${netSh >= 0 ? '+' : ''}${netSh.toLocaleString()} sh`}
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

function Row({ label, value, accent, accentColor }: { label: string; value: string; accent?: string; accentColor?: string }) {
  return (
    <tr className="border-b border-ink-800">
      <td className="py-1 pr-2 text-ink-400">{label}</td>
      <td className={`py-1 text-right font-mono ${accentColor ?? 'text-ink-100'}`}>{value}</td>
      {accent !== undefined && <td className="py-1 pl-2 text-right text-[10px] text-ink-500">{accent}</td>}
    </tr>
  );
}
