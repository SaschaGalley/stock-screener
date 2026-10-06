import type { OverviewRow, TimingReadings } from '../types';
import { BARRIER_SETS, SETUPS, tradePlan, type Setup } from '../../../src/analysis/setups';
import type { SetupStudy } from '../../../src/backtest/setups';
import { fmtPrice } from '../format';
import Tip from './Tip';

const pct = (v: number | null | undefined, d = 1) =>
  (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d).replace('.', ',')} %`);
const num = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d).replace('.', ',').replace('-', '−'));

/** Mean absolute daily move to annual volatility: √(π/2) for a normal day, √252 days. */
const ATR_TO_VOL = Math.sqrt(Math.PI / 2) * Math.sqrt(252);
/** The share of the depot a stopped trade may cost, for the position size shown. */
const RISK_BUDGET = 0.01;

type Level = 'niedrig' | 'mittel' | 'hoch';

/**
 * How much can go wrong beside the stop: how much the price swings, whether a
 * cap on the verdict flags distress or doubtful accounts, and how far the
 * score's own data can be trusted. Said with its reasons, never as a number
 * of its own.
 */
function riskOf(row: OverviewRow, t: TimingReadings): { level: Level; reasons: string[] } {
  const reasons: string[] = [];
  let level = 0;
  const vol = t.atr14 !== null ? t.atr14 * ATR_TO_VOL : null;
  if (vol !== null) {
    if (vol >= 0.6) { level = 2; reasons.push(`Schwankung etwa ${pct(vol, 0).replace('+', '')} im Jahr`); }
    else if (vol >= 0.35) { level = Math.max(level, 1); reasons.push(`Schwankung etwa ${pct(vol, 0).replace('+', '')} im Jahr`); }
    else reasons.push(`ruhige Aktie, Schwankung etwa ${pct(vol, 0).replace('+', '')} im Jahr`);
  }
  if (row.capReasons.length) { level = 2; reasons.push(...row.capReasons); }
  if (row.scoreConfidence !== null && row.scoreConfidence < 0.5) {
    level = Math.max(level, 1);
    reasons.push(`Datenlage dünn (Konfidenz ${Math.round(row.scoreConfidence * 100)} %)`);
  }
  return { level: (['niedrig', 'mittel', 'hoch'] as const)[level], reasons };
}

const LEVEL_COLOR: Record<Level, string> = { niedrig: 'text-emerald-400', mittel: 'text-amber-300', hoch: 'text-red-400' };
const VERDICT_COLOR: Record<string, string> = { 'trägt': 'text-emerald-400', 'warnt': 'text-red-400', 'nicht belegt': 'text-ink-400' };

/** The setups that fire on a stock today, from the same definitions the backtest tested. */
export function firingSetups(row: OverviewRow): Setup[] {
  const t = row.timing;
  if (!t) return [];
  const fairGap = row.compositeFairValue && row.price && row.compositeFairValue > 0 && row.price > 0
    ? Math.log(row.compositeFairValue / row.price) : null;
  return SETUPS.filter((s) => s.fires({ t, fairGap }));
}

/** Each setup's idea and record, the trade plan and the risk — the badge's hover, and the stock page's. */
export function SetupPlan({ row, t, setups, study }: { row: OverviewRow; t: TimingReadings; setups: Setup[]; study: SetupStudy | null }) {
  const risk = riskOf(row, t);
  return (
    <div className="max-w-md">
      {setups.map((s) => (
        <div key={s.key} className="mb-2">
          <div className="font-semibold text-ink-100">{s.title}</div>
          <div className="text-ink-400">{s.idea}</div>
          {study ? (
            <div className="mt-1 space-y-0.5 text-2xs">
              {study.geometries.map((g) => {
                const r = g.setups.find((x) => x.key === s.key);
                return (
                  <div key={g.barriers.key}>
                    <span className="text-ink-500">{g.barriers.label}{g.judged ? '' : ' (gezeigt)'}: </span>
                    <span className={VERDICT_COLOR[r?.verdict ?? 'nicht belegt']}>{r?.verdict ?? '—'}</span>
                    <span className="text-ink-400">
                      {' '}· {pct(r?.excess.mean, 2)} je Trade gegen Zufall (t {num(r?.excess.t)}) · Ziel erreicht {Math.round((r?.target ?? 0) * 100)} %, zufällig {Math.round(g.baseline.target * 100)} %
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-1 text-2xs text-ink-500">Der neueste Backtest hat die Setups noch nicht geprüft.</div>
          )}
        </div>
      ))}

      {t.atr14 !== null && row.price !== null && (
        <table className="mt-1 w-full text-2xs">
          <thead className="text-ink-500">
            <tr><th className="text-left font-normal" /><th className="text-right font-normal">Stop</th><th className="pl-2 text-right font-normal">Ziel</th><th className="whitespace-nowrap pl-2 text-right font-normal" title={`Positionsgröße, bei der ein Stop ${pct(RISK_BUDGET, 0).replace('+', '')} des Depots kostet`}>Größe*</th></tr>
          </thead>
          <tbody>
            {BARRIER_SETS.map((b) => {
              const p = tradePlan(row.price!, t.atr14!, b);
              return (
                <tr key={b.key}>
                  <td className="pr-2 text-ink-400">{b.label}</td>
                  <td className="whitespace-nowrap text-right font-mono text-red-300">{fmtPrice(p.stop, row.currency)} <span className="text-ink-500">({pct(-p.risk)})</span></td>
                  <td className="whitespace-nowrap pl-2 text-right font-mono text-emerald-300">{fmtPrice(p.target, row.currency)} <span className="text-ink-500">({pct(p.reward)})</span></td>
                  <td className="whitespace-nowrap pl-2 text-right font-mono text-ink-300">{pct(Math.min(1, RISK_BUDGET / p.risk), 0).replace('+', '')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="mt-1.5">
        Risiko <span className={`font-semibold ${LEVEL_COLOR[risk.level]}`}>{risk.level}</span>
        {risk.reasons.length > 0 && <span className="text-ink-400">: {risk.reasons.join(' · ')}</span>}
      </div>
      <p className="mt-1 text-ink-500">
        Stop und Ziel allein schaffen keinen Vorteil: Wer zufällig einsteigt, erreicht das Ziel so oft, wie die Abstände es vorgeben. Ein Setup
        zählt nur, wenn es den Zufallseinstieg mit denselben Abständen schlägt. Der faire Wert der App ist nicht ganz der des Backtests.
        * Anteil am Depot, bei dem ein Stop 1 % des Depots kostet. Keine Anlageberatung.
      </p>
    </div>
  );
}

/** A setup firing on the stock today, as a mark beside its chart; the plan and the evidence on hover. */
export default function SetupBadge({ row, study }: { row: OverviewRow; study: SetupStudy | null }) {
  const t = row.timing;
  const setups = firingSetups(row);
  if (!t || !setups.length) return null;
  const judged = study?.geometries.find((g) => g.judged);
  const carried = setups.some((s) => judged?.setups.find((x) => x.key === s.key)?.verdict === 'trägt');
  return (
    <Tip
      focusable={false}
      className={`ml-1 rounded border px-1 text-3xs leading-3.5 ${carried ? 'border-emerald-700 text-emerald-300' : 'border-ink-700 text-ink-400'}`}
      content={<SetupPlan row={row} t={t} setups={setups} study={study} />}
    >
      {setups.length === 1 ? setups[0].title : `${setups.length} Setups`}
    </Tip>
  );
}
