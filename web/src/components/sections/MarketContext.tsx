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
  if (!ms) return <p className="text-xs text-ink-500">No market context cached.</p>;
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
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
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

function OptionsBlock({ o }: { o: any }) {
  if (!o) return <Block title="Options Market"><p className="text-xs text-ink-500">No options chain.</p></Block>;
  return (
    <Block title="Options Market">
      <table className="w-full text-xs tabular">
        <tbody>
          <Row label="ATM IV (~30d)" term="signals.options.ivAtm30d" value={fmtPct(o.ivAtm30d)} />
          <Row label="IV / HV90"     term="signals.options.ivVsHv90Ratio" value={fmt(o.ivVsHv90Ratio, 'x', 2)}
            accent={o.ivVsHv90Ratio > 1.3 ? 'rich' : o.ivVsHv90Ratio < 0.8 ? 'cheap' : ''}
            accentColor={o.ivVsHv90Ratio > 1.3 ? 'text-red-400' : o.ivVsHv90Ratio < 0.8 ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="Put/Call Volume" term="signals.options.putCallVolumeRatio" value={fmt(o.putCallVolumeRatio, '', 2)}
            accent={o.putCallVolumeRatio > 1.2 ? 'bearish' : o.putCallVolumeRatio < 0.7 ? 'bullish' : ''}
            accentColor={o.putCallVolumeRatio > 1.2 ? 'text-red-400' : o.putCallVolumeRatio < 0.7 ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="P/C Open Interest" term="signals.options.putCallOIRatio" value={fmt(o.putCallOIRatio, '', 2)} />
          {o.nextEarningsImpliedMove?.pct != null && Number.isFinite(o.nextEarningsImpliedMove.pct) && (
            <Row label="Earnings move" term="signals.options.nextEarningsImpliedMove.pct"
              value={`±${fmtPct(o.nextEarningsImpliedMove.pct, 1)}`}
              accent={`expiry ${o.nextEarningsImpliedMove.expirationDate ?? '—'}`} />
          )}
        </tbody>
      </table>
    </Block>
  );
}

function RevisionsBlock({ r }: { r: any }) {
  if (!r || !r.perPeriod || r.perPeriod.length === 0) {
    return <Block title="Earnings Revisions"><p className="text-xs text-ink-500">No revision data.</p></Block>;
  }
  const PERIOD_LABEL: Record<string, string> = { '0q': 'Cur Qtr', '+1q': 'Nxt Qtr', '0y': 'Cur Year', '+1y': 'Nxt Year' };
  return (
    <Block title={<Term k="concept.revisions">Earnings Revisions</Term>}>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-800 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-medium">Period</th>
            <th className="py-1 px-2 text-right font-medium"><Term k="signals.revisions.perPeriod.0q.epsChange30dPct">30d Drift</Term></th>
            <th className="py-1 pl-2 text-right font-medium"><Term k="signals.revisions.perPeriod.0q.netRevision30d">Net 30d</Term></th>
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

function MacroBlock({ m }: { m: any }) {
  if (!m) return <Block title="Macro Context"><p className="text-xs text-ink-500">No macro data.</p></Block>;
  return (
    <Block title="Macro Context">
      <table className="w-full text-xs tabular">
        <tbody>
          <Row label="VIX" term="macro.vix" value={fmt(m.vix, '', 1)} accent={m.vixRegime} accentColor={
            m.vixRegime === 'high' ? 'text-red-400' :
            m.vixRegime === 'elevated' ? 'text-amber-400' :
            m.vixRegime === 'low' ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="SPY 3M"           term="macro.spy3MReturn" value={fmtSignedPct(m.spy3MReturn)} />
          <Row label="Yield curve 10-2" term="macro.yieldCurve2Y10Y" value={m.yieldCurve2Y10Y == null ? '—' : `${deNumber(m.yieldCurve2Y10Y, 0)} bps`}
            accentColor={m.yieldCurve2Y10Y < 0 ? 'text-red-400' : m.yieldCurve2Y10Y < 50 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="HY spread" term="macro.hySpreadBps" value={m.hySpreadBps == null ? '—' : `${deNumber(m.hySpreadBps, 0)} bps`}
            accentColor={m.hySpreadBps > 600 ? 'text-red-400' : m.hySpreadBps > 400 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="DXY" term="macro.dxyLevel" value={fmt(m.dxyLevel, '', 1)} accent={fmtSignedPct(m.dxyChange3MPct)} />
          {m.sectorEtfSymbol && (
            <Row label={`Sector ${m.sectorEtfSymbol} 3M`} term="macro.sectorEtfReturn3M" value={fmtSignedPct(m.sectorEtfReturn3M)} />
          )}
        </tbody>
      </table>
    </Block>
  );
}
