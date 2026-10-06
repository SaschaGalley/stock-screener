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
        <h3 className="mb-2 text-xs font-semibold text-ink-300">Leerverkäufe</h3>
        {f.shortPercentOfFloat != null && Number.isFinite(f.shortPercentOfFloat) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              <Row label="Anteil am Streubesitz" term="financials.shortPercentOfFloat" value={fmtPct(f.shortPercentOfFloat, 1)}
                accentColor={f.shortPercentOfFloat > 0.20 ? 'text-red-400' : f.shortPercentOfFloat > 0.08 ? 'text-amber-400' : 'text-emerald-400'} />
              <Row label="Leerverkaufte Aktien"  term="financials.sharesShort" value={fmtCount(f.sharesShort)} />
              <Row label="Tage zur Eindeckung" term="financials.shortRatio" value={f.shortRatio != null && Number.isFinite(f.shortRatio) ? deNumber(f.shortRatio, 1) + ' T' : '—'} />
              {f.sharesShort != null && f.sharesShortPriorMonth != null && f.sharesShortPriorMonth > 0 && (() => {
                const chg = (f.sharesShort - f.sharesShortPriorMonth) / f.sharesShortPriorMonth * 100;
                return <Row label="ggü. Vormonat" term="concept.shortMoM" value={fmtPercentPoints(chg, 0)}
                  accentColor={chg >= 0 ? 'text-red-400' : 'text-emerald-400'} />;
              })()}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">Keine Leerverkaufsdaten.</p>}
      </div>

      {/* Ownership */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-ink-300">Aktionärsstruktur</h3>
        {(f.institutionsPercentHeld != null || f.insidersPercentHeld != null) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              {f.institutionsPercentHeld != null && Number.isFinite(f.institutionsPercentHeld) && (
                <Row label="Institutionen" term="financials.institutionsPercentHeld"
                  value={fmtPct(f.institutionsPercentHeld, 1)}
                  accent={f.institutionsCount ? `${f.institutionsCount.toLocaleString('de-DE')} Halter` : ''} />
              )}
              {f.insidersPercentHeld != null && Number.isFinite(f.insidersPercentHeld) && (
                <Row label="Insiders" term="financials.insidersPercentHeld" value={fmtPct(f.insidersPercentHeld, 1)} />
              )}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">Keine Daten zur Aktionärsstruktur.</p>}
      </div>

      {/* Insider activity */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-ink-300">
          <Term k="concept.insiderActivity">Insider-Aktivität</Term> <span className="text-ink-500">(6 M)</span>
        </h3>
        {(f.insiderBuyCount > 0 || f.insiderSellCount > 0) ? (
          <table className="w-full text-xs tabular">
            <tbody>
              {f.insiderBuyCount > 0 && (
                <Row
                  label="Käufe"
                  value={`${f.insiderBuyCount} Trans.`}
                  accent={`+${f.insiderBuyShares?.toLocaleString('de-DE') ?? 0} Stk. / ${fmtBig(f.insiderBuyValue)}`}
                  accentColor="text-emerald-400"
                />
              )}
              {f.insiderSellCount > 0 && (
                <Row
                  label="Verkäufe"
                  value={`${f.insiderSellCount} Trans.`}
                  accent={`−${f.insiderSellShares?.toLocaleString('de-DE') ?? 0} Stk. / ${fmtBig(f.insiderSellValue)}`}
                  accentColor="text-red-400"
                />
              )}
              {f.insiderBuyCount > 0 && f.insiderSellCount > 0 && (() => {
                const netSh = (f.insiderBuyShares ?? 0) - (f.insiderSellShares ?? 0);
                const netVal = (f.insiderBuyValue ?? 0) - (f.insiderSellValue ?? 0);
                return <Row label="Saldo" value={`${netSh >= 0 ? '+' : ''}${deNumber(netSh, 0)} Stk.`}
                  accent={fmtBig(netVal)}
                  accentColor={netSh >= 0 ? 'text-emerald-400' : 'text-red-400'} />;
              })()}
            </tbody>
          </table>
        ) : <p className="text-xs text-ink-500">Keine Transaktionen in letzter Zeit.</p>}
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
