import { deNumber, fmt, fmtPct, fmtSignedPct } from '../../format';
import Term from '../Term';
import type { GlossaryKey } from '../../glossary';

interface Props {
  marketSignals: any;
}

/**
 * External market context — what's the world around this stock saying?
 * Options pricing, analyst revisions, macro environment.
 */
export default function MarketContext({ marketSignals: ms }: Props) {
  if (!ms) return <p className="text-xs text-ink-500">Kein Marktumfeld gespeichert.</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <OptionsBlock o={ms.options} />
      <RevisionsBlock r={ms.revisions} />
      <MacroBlock m={ms.macro} />
    </div>
  );
}

function Block({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">{title}</h3>
      {children}
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

/** "2026-10-17" → "17.10.2026"; anything else as it came. */
const dayDe = (d: string | null | undefined) =>
  !d ? '—' : /^\d{4}-\d{2}-\d{2}/.test(d) ? `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}` : d;

function OptionsBlock({ o }: { o: any }) {
  if (!o) return <Block title="Optionsmarkt"><p className="text-xs text-ink-500">Keine Optionskette.</p></Block>;
  return (
    <Block title="Optionsmarkt">
      <table className="w-full text-xs tabular">
        <tbody>
          <Row label="Implizite Vola (~30 T)" term="signals.options.ivAtm30d" value={fmtPct(o.ivAtm30d)} />
          <Row label="IV / HV90"     term="signals.options.ivVsHv90Ratio" value={fmt(o.ivVsHv90Ratio, 'x', 2)}
            accent={o.ivVsHv90Ratio > 1.3 ? 'teuer' : o.ivVsHv90Ratio < 0.8 ? 'günstig' : ''}
            accentColor={o.ivVsHv90Ratio > 1.3 ? 'text-red-400' : o.ivVsHv90Ratio < 0.8 ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="Put/Call-Volumen" term="signals.options.putCallVolumeRatio" value={fmt(o.putCallVolumeRatio, '', 2)}
            accent={o.putCallVolumeRatio > 1.2 ? 'bärisch' : o.putCallVolumeRatio < 0.7 ? 'bullisch' : ''}
            accentColor={o.putCallVolumeRatio > 1.2 ? 'text-red-400' : o.putCallVolumeRatio < 0.7 ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="Put/Call Open Interest" term="signals.options.putCallOIRatio" value={fmt(o.putCallOIRatio, '', 2)} />
          {o.nextEarningsImpliedMove?.pct != null && Number.isFinite(o.nextEarningsImpliedMove.pct) && (
            <Row label="Erwartete Bewegung zu den Zahlen" term="signals.options.nextEarningsImpliedMove.pct"
              value={`±${fmtPct(o.nextEarningsImpliedMove.pct, 1)}`}
              accent={`Verfall ${dayDe(o.nextEarningsImpliedMove.expirationDate)}`} />
          )}
        </tbody>
      </table>
    </Block>
  );
}

function RevisionsBlock({ r }: { r: any }) {
  if (!r || !r.perPeriod || r.perPeriod.length === 0) {
    return <Block title="Gewinnrevisionen"><p className="text-xs text-ink-500">Keine Revisionsdaten.</p></Block>;
  }
  const PERIOD_LABEL: Record<string, string> = { '0q': 'Laufendes Quartal', '+1q': 'Nächstes Quartal', '0y': 'Laufendes Jahr', '+1y': 'Nächstes Jahr' };
  return (
    <Block title={<Term k="concept.revisions">Gewinnrevisionen</Term>}>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-800 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-medium">Zeitraum</th>
            <th className="py-1 px-2 text-right font-medium"><Term k="signals.revisions.perPeriod.0q.epsChange30dPct">Drift 30 T</Term></th>
            <th className="py-1 pl-2 text-right font-medium"><Term k="signals.revisions.perPeriod.0q.netRevision30d">Saldo 30 T</Term></th>
          </tr>
        </thead>
        <tbody>
          {r.perPeriod.map((p: any) => {
            const drift = p.epsChange30dPct;
            const net = p.netRevision30d;
            return (
              <tr key={p.period} className="border-b border-ink-800">
                <td className="py-1 pr-2 text-ink-300">{PERIOD_LABEL[p.period] ?? p.period}</td>
                <td className={`py-1 px-2 text-right font-mono ${drift > 0 ? 'text-emerald-400' : drift < 0 ? 'text-red-400' : 'text-ink-400'}`}>
                  {fmtSignedPct(drift)}
                </td>
                <td className={`py-1 pl-2 text-right font-mono ${net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-ink-400'}`}>
                  {net == null ? '—' : net > 0 ? `+${net}` : deNumber(net, 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Block>
  );
}

const VIX_REGIME: Record<string, string> = { low: 'niedrig', normal: 'normal', elevated: 'erhöht', high: 'hoch', unknown: '' };

function MacroBlock({ m }: { m: any }) {
  if (!m) return <Block title="Makro"><p className="text-xs text-ink-500">Keine Makrodaten.</p></Block>;
  return (
    <Block title="Makro">
      <table className="w-full text-xs tabular">
        <tbody>
          <Row label="VIX" term="macro.vix" value={fmt(m.vix, '', 1)} accent={VIX_REGIME[m.vixRegime] ?? m.vixRegime} accentColor={
            m.vixRegime === 'high' ? 'text-red-400' :
            m.vixRegime === 'elevated' ? 'text-amber-400' :
            m.vixRegime === 'low' ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="S&P 500 3 M"           term="macro.spy3MReturn" value={fmtSignedPct(m.spy3MReturn)} />
          <Row label="Zinskurve 10 J − 2 J" term="macro.yieldCurve2Y10Y" value={m.yieldCurve2Y10Y == null ? '—' : `${deNumber(m.yieldCurve2Y10Y, 0)} Bp.`}
            accentColor={m.yieldCurve2Y10Y < 0 ? 'text-red-400' : m.yieldCurve2Y10Y < 50 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="High-Yield-Spread" term="macro.hySpreadBps" value={m.hySpreadBps == null ? '—' : `${deNumber(m.hySpreadBps, 0)} Bp.`}
            accentColor={m.hySpreadBps > 600 ? 'text-red-400' : m.hySpreadBps > 400 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="DXY" term="macro.dxyLevel" value={fmt(m.dxyLevel, '', 1)} accent={fmtSignedPct(m.dxyChange3MPct)} />
          {m.sectorEtfSymbol && (
            <Row label={`Sektor ${m.sectorEtfSymbol} 3 M`} term="macro.sectorEtfReturn3M" value={fmtSignedPct(m.sectorEtfReturn3M)} />
          )}
        </tbody>
      </table>
    </Block>
  );
}
