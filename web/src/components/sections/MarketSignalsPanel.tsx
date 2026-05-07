import { fmt, fmtPct, fmtSignedPct } from '../../format';

interface Props {
  marketSignals: any;
}

export default function MarketSignalsPanel({ marketSignals: ms }: Props) {
  if (!ms) return <p className="text-xs text-ink-500">No market signals cached.</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Technicals t={ms.technicals} />
      <OptionsPanel o={ms.options} />
      <Revisions r={ms.revisions} />
      <Macro m={ms.macro} />
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
      {children}
    </div>
  );
}

function Technicals({ t }: { t: any }) {
  if (!t) return null;
  const rsiColor = t.rsi14 === null ? 'text-ink-400' :
    t.rsi14 >= 70 ? 'text-red-400' :
    t.rsi14 <= 30 ? 'text-emerald-400' : 'text-ink-100';
  return (
    <Block title="Technicals">
      <table className="w-full text-xs tabular">
        <tbody>
          <Row label="SMA 50"  value={fmt(t.sma50)} accent={fmtSignedPct(t.distFromSMA50Pct)} />
          <Row label="SMA 200" value={fmt(t.sma200)} accent={fmtSignedPct(t.distFromSMA200Pct)} />
          <Row label="Trend"   value={t.goldenCross === null ? '—' : t.goldenCross ? '✓ Golden Cross' : '✗ Death Cross'} accentColor={t.goldenCross ? 'text-emerald-400' : 'text-red-400'} />
          <Row label="RSI 14"  value={fmt(t.rsi14, '', 1)} accentColor={rsiColor}
            accent={t.rsi14 === null ? '' : t.rsi14 >= 70 ? 'overbought' : t.rsi14 <= 30 ? 'oversold' : ''} />
          <Row label="MACD Hist"   value={fmt(t.macdHistogram, '', 2)}
            accentColor={t.macdHistogram > 0 ? 'text-emerald-400' : 'text-red-400'} />
          <Row label="ATR 14"      value={fmtPct(t.atr14Pct)} />
          <Row label="HV 30 / 90"  value={`${fmtPct(t.hv30)} / ${fmtPct(t.hv90)}`} />
          <Row label="Drawdown"    value={fmtSignedPct(t.drawdownFromHighPct)} />
          <Row label="52W position" value={fmtPct(t.position52WPct)} />
          <Row label="RS vs SPY 3M"   value={fmtSignedPct(t.rsVsSPY3M)} />
          <Row label="RS vs Sector ETF" value={fmtSignedPct(t.rsVsSector3M)} />
        </tbody>
      </table>
    </Block>
  );
}

function OptionsPanel({ o }: { o: any }) {
  if (!o) return <Block title="Options"><p className="text-xs text-ink-500">No options chain available.</p></Block>;
  return (
    <Block title="Options Market">
      <table className="w-full text-xs tabular">
        <tbody>
          <Row label="ATM IV (~30d)" value={fmtPct(o.ivAtm30d)} />
          <Row label="IV / HV90"     value={fmt(o.ivVsHv90Ratio, 'x', 2)}
            accentColor={o.ivVsHv90Ratio > 1.3 ? 'text-red-400' : o.ivVsHv90Ratio < 0.8 ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="Put/Call Volume" value={fmt(o.putCallVolumeRatio, '', 2)}
            accentColor={o.putCallVolumeRatio > 1.2 ? 'text-red-400' : o.putCallVolumeRatio < 0.7 ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="P/C Open Interest" value={fmt(o.putCallOIRatio, '', 2)} />
          {o.nextEarningsImpliedMove && (
            <Row label="Earnings move"
              value={`±${(o.nextEarningsImpliedMove.pct * 100).toFixed(1)}%`}
              accent={`expiry ${o.nextEarningsImpliedMove.expirationDate}`} />
          )}
        </tbody>
      </table>
    </Block>
  );
}

function Revisions({ r }: { r: any }) {
  if (!r || r.perPeriod.length === 0) return null;
  const PERIOD_LABEL: Record<string, string> = { '0q': 'Cur Qtr', '+1q': 'Nxt Qtr', '0y': 'Cur Year', '+1y': 'Nxt Year' };
  return (
    <Block title="Earnings Revisions Momentum">
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-medium">Period</th>
            <th className="py-1 px-2 text-right font-medium">Estimate</th>
            <th className="py-1 px-2 text-right font-medium">30d Drift</th>
            <th className="py-1 pl-2 text-right font-medium">Net 30d</th>
          </tr>
        </thead>
        <tbody>
          {r.perPeriod.map((p: any) => {
            const drift = p.epsChange30dPct;
            const net = p.netRevision30d;
            return (
              <tr key={p.period} className="border-b border-ink-800/60">
                <td className="py-1 pr-2 text-ink-300">{PERIOD_LABEL[p.period] ?? p.period}</td>
                <td className="py-1 px-2 text-right font-mono text-ink-100">{fmt(p.epsTrend.current)}</td>
                <td className={`py-1 px-2 text-right font-mono ${drift > 0 ? 'text-emerald-400' : drift < 0 ? 'text-red-400' : 'text-ink-400'}`}>
                  {fmtSignedPct(drift)}
                </td>
                <td className={`py-1 pl-2 text-right font-mono ${net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-ink-400'}`}>
                  {net === null ? '—' : net > 0 ? `+${net}` : net}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Block>
  );
}

function Macro({ m }: { m: any }) {
  if (!m) return null;
  return (
    <Block title="Macro Context">
      <table className="w-full text-xs tabular">
        <tbody>
          <Row label="VIX" value={fmt(m.vix, '', 1)} accent={m.vixRegime} accentColor={
            m.vixRegime === 'high' ? 'text-red-400' :
            m.vixRegime === 'elevated' ? 'text-amber-400' :
            m.vixRegime === 'low' ? 'text-emerald-400' : 'text-ink-100'} />
          <Row label="SPY 3M"           value={fmtSignedPct(m.spy3MReturn)} />
          <Row label="Yield curve 10-2" value={m.yieldCurve2Y10Y === null ? '—' : `${m.yieldCurve2Y10Y.toFixed(0)}bps`}
            accentColor={m.yieldCurve2Y10Y < 0 ? 'text-red-400' : m.yieldCurve2Y10Y < 50 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="HY spread"        value={m.hySpreadBps === null ? '—' : `${m.hySpreadBps.toFixed(0)}bps`}
            accentColor={m.hySpreadBps > 600 ? 'text-red-400' : m.hySpreadBps > 400 ? 'text-amber-400' : 'text-emerald-400'} />
          <Row label="DXY"              value={fmt(m.dxyLevel, '', 1)} accent={fmtSignedPct(m.dxyChange3MPct)} />
          {m.sectorEtfSymbol && (
            <Row label={`Sector ${m.sectorEtfSymbol} 3M`} value={fmtSignedPct(m.sectorEtfReturn3M)} />
          )}
        </tbody>
      </table>
    </Block>
  );
}

function Row({ label, value, accent, accentColor }: { label: string; value: string; accent?: string; accentColor?: string }) {
  return (
    <tr className="border-b border-ink-800/60">
      <td className="py-1 pr-2 text-ink-400">{label}</td>
      <td className={`py-1 text-right font-mono ${accentColor ?? 'text-ink-100'}`}>{value}</td>
      {accent !== undefined && (
        <td className="py-1 pl-2 text-right text-[10px] text-ink-500">{accent}</td>
      )}
    </tr>
  );
}
