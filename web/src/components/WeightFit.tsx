import type { BacktestResponse } from '../types';
import { SignedBar } from './evaluationParts';
import { deNumber, fmt, fmtPct } from '../format';

type Validation = NonNullable<BacktestResponse['backtest']>['fit'];
type Fold = Validation['forward'];
type Row = Validation['full']['rows'][number];
type InForce = BacktestResponse['inForce'];

const months = (h: number) => (h === 1 ? '1 Monat' : `${h} Monate`);
const share = (w: number) => fmtPct(w, 1);
const years = (from: string | null, to: string | null) => `${from?.slice(0, 4) ?? '—'}–${to?.slice(0, 4) ?? '—'}`;
const signed = (v: number | null | undefined, digits: number) =>
  (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${deNumber(v, digits)}`);
const decimal = (v: number, digits: number) => v.toFixed(digits).replace('.', ',');
const rowId = (r: Row) => `${r.pillar}.${r.key ?? ''}`;

/** Whether the weights in force are this fit's, to the three decimals it is kept to. */
function inForceIsFit(v: Validation, inForce: InForce): boolean {
  if (!inForce.fit) return false;
  return v.full.rows.every((r) => {
    const now = r.key === null ? inForce.weights.pillars[r.pillar] : inForce.weights.criteria[r.pillar][r.key];
    return Math.abs(now - r.fitted) < 0.0005;
  });
}

function FoldRows({ name, fold }: { name: string; fold: Fold }) {
  // A fit that moved nothing scores exactly as the judgment does: no gain, and no month ahead or behind.
  const same = !fold.fit.moved;
  return (
    <>
      {fold.comparisons.map((c, i) => {
        const gain = same ? null : c.gain.mean;
        return (
          <tr key={`${name}-${c.horizon}`} className="border-b border-ink-800/60 last:border-0">
            <td className="px-4 py-1.5 text-ink-200">{i === 0 ? name : ''}</td>
            <td className="px-2 py-1.5 font-mono text-ink-400">{i === 0 ? years(fold.fit.from, fold.fit.to) : ''}</td>
            <td className="px-2 py-1.5 font-mono text-ink-400">{i === 0 ? years(fold.tested.from, fold.tested.to) : ''}</td>
            <td className="px-2 py-1.5 text-ink-300">{months(c.horizon)}</td>
            <td className="px-2 py-1.5 text-right font-mono text-ink-300">{fmt(c.judgment.ic, '', 3)}</td>
            <td className="px-2 py-1.5 text-right font-mono text-ink-100">{fmt(c.fitted.ic, '', 3)}</td>
            <td className={`px-2 py-1.5 text-right font-mono ${!gain ? 'text-ink-500' : gain > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {signed(gain, 4)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-ink-300">{same ? '—' : fmt(c.gain.tStat, '', 1)}</td>
            <td className="px-4 py-1.5 text-right font-mono text-ink-400">
              {same
                ? <span className="text-ink-500">Regel ändert nichts</span>
                : <>{c.gain.ahead === null ? '—' : `${Math.round(c.gain.ahead * 100)} %`} <span className="text-ink-500">von {c.independent}</span></>}
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** An IC in one half of the months, dimmed where it is less than one standard error from zero. */
function HalfIc({ r }: { r: Row | undefined }) {
  if (!r || r.ic === null) return <td className="px-2 py-1.5 text-right font-mono text-ink-600">—</td>;
  const clear = r.se !== null && Math.abs(r.ic) >= r.se;
  const tone = !clear ? 'text-ink-500' : r.ic > 0 ? 'text-emerald-400' : 'text-red-400';
  return <td className={`px-2 py-1.5 text-right font-mono ${tone}`}>{signed(r.ic, 3)}</td>;
}

/**
 * The weights the backtest would fit, and whether that fit beat the judgment
 * weights on the years it had not seen — in both directions.
 */
export default function WeightFit({ v, inForce }: { v: Validation; inForce: InForce }) {
  const measured = new Set(v.full.rows.filter((r) => r.key === null && r.ic !== null).map((r) => r.pillar));
  const rows = v.full.rows.filter((r) => measured.has(r.pillar));
  const unmeasured = v.full.rows.filter((r) => r.key === null && !measured.has(r.pillar));
  const first = new Map(v.forward.fit.rows.map((r) => [rowId(r), r]));
  const second = new Map(v.reverse.fit.rows.map((r) => [rowId(r), r]));
  const fitted = inForce.fit !== null;
  const current = inForceIsFit(v, inForce);
  // What would be committed is the fit on every month; the halves only check the rule.
  const nothingMoved = !v.full.moved;
  const weightNow = (r: Row) => (r.key === null ? inForce.weights.pillars[r.pillar] : inForce.weights.criteria[r.pillar][r.key]);
  const { criteria: jc, pillars: jp } = v.full.joint;

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Gewichte: angepasst und auf ungesehenen Jahren geprüft</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
          Jedes Gewicht wird um den IC seines Kriteriums über {months(v.horizon)} gekippt, zur Null geschrumpft um seinen
          Standardfehler — erst die Kriterien in ihrer Säule, dann die Säulen. Wie weit, liest die Regel aus der Streuung der
          ICs jenseits ihres Rauschens: Unterscheiden sich die Kriterien nicht mehr, als Zufall erklärt, bewegt sich nichts.
          Angepasst auf der einen Hälfte der Monate, gegen die Urteilsgewichte gemessen auf der anderen.
        </p>
      </header>

      <p className={`border-b border-ink-800 px-4 py-2.5 text-xs leading-relaxed ${v.held ? 'text-emerald-400' : nothingMoved ? 'text-ink-200' : 'text-amber-400'}`}>
        {v.held
          ? 'Gehalten: Die angepassten Gewichte ranken auf den ungesehenen Jahren in beiden Richtungen besser als die Urteilsgewichte. '
          : nothingMoved
            ? `Nichts anzupassen: Zusammen ranken die ${jc.k} Kriterien nicht besser als Zufall — die quadrierten t-Werte summieren sich `
              + `auf ${decimal(jc.sumT2, 1)}, ohne jede Vorhersagekraft wären es im Mittel ${jc.k} (Säulen: ${decimal(jp.sumT2, 1)} bei ${jp.k}). `
              + 'Ihre Unterschiede sind so groß, wie Rauschen sie macht, und die Regel lässt jedes Gewicht, wo das Urteil es gesetzt hat. '
            : 'Nicht gehalten: Auf den ungesehenen Jahren schlagen die angepassten Gewichte die Urteilsgewichte nicht in beiden Richtungen — '
              + 'die Urteilsgewichte bleiben. '}
        <span className="text-ink-500">
          {current
            ? `In Kraft ist die Anpassung auf allen Monaten, seit ${new Date(inForce.fit!.generatedAt).toLocaleDateString('de-DE')}.`
            : fitted
              ? `In Kraft ist eine frühere Anpassung (${new Date(inForce.fit!.generatedAt).toLocaleDateString('de-DE')}).`
              : v.held ? 'Übernommen wird sie mit pnpm run backtest -- --write-weights.' : 'In Kraft sind die Urteilsgewichte.'}
        </span>
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] whitespace-nowrap text-sm">
          <thead className="text-xs text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="px-4 py-2 text-left font-normal">Richtung</th>
              <th className="px-2 py-2 text-left font-normal">angepasst auf</th>
              <th className="px-2 py-2 text-left font-normal">geprüft auf</th>
              <th className="px-2 py-2 text-left font-normal">Horizont</th>
              <th className="px-2 py-2 text-right font-normal">IC Urteil</th>
              <th className="px-2 py-2 text-right font-normal">IC angepasst</th>
              <th className="px-2 py-2 text-right font-normal">Gewinn</th>
              <th className="px-2 py-2 text-right font-normal">t</th>
              <th className="px-4 py-2 text-right font-normal">Monate vorn</th>
            </tr>
          </thead>
          <tbody>
            <FoldRows name="Vorwärts" fold={v.forward} />
            <FoldRows name="Rückwärts" fold={v.reverse} />
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto border-t border-ink-800">
        <table className="w-full min-w-[720px] whitespace-nowrap text-sm">
          <thead className="text-xs text-ink-400">
            <tr className="border-b border-ink-800">
              <th className="px-4 py-2 text-left font-normal">Säule / Kriterium</th>
              <th className="px-2 py-2 text-right font-normal">Urteil</th>
              <th className="px-2 py-2 text-right font-normal">Regel</th>
              <th className="w-20 px-2 py-2 font-normal" />
              {fitted && <th className="px-2 py-2 text-right font-normal">in Kraft</th>}
              <th className="px-2 py-2 text-right font-normal">IC {years(v.forward.fit.from, v.forward.fit.to)}</th>
              <th className="px-2 py-2 text-right font-normal">IC {years(v.reverse.fit.from, v.reverse.fit.to)}</th>
              <th className="px-4 py-2 text-right font-normal">IC gesamt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pillar = r.key === null;
              return (
                <tr key={rowId(r)} className={`border-b border-ink-800/60 last:border-0 ${pillar ? 'bg-ink-800/30' : ''}`}>
                  <td className={`min-w-[11rem] whitespace-normal px-4 py-1.5 ${pillar ? 'font-medium text-ink-100' : 'pl-8 text-ink-300'}`}>{r.label}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-ink-300">{share(r.judgment)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${Math.abs(r.fitted - r.judgment) < 0.0005 ? 'text-ink-500' : 'text-ink-100'}`}>
                    {share(r.fitted)}
                  </td>
                  <td className="px-2 py-1.5"><SignedBar value={r.fitted - r.judgment} scale={0.15} /></td>
                  {fitted && <td className="px-2 py-1.5 text-right font-mono text-ink-300">{share(weightNow(r))}</td>}
                  <HalfIc r={first.get(rowId(r))} />
                  <HalfIc r={second.get(rowId(r))} />
                  <td className="px-4 py-1.5 text-right font-mono text-ink-400">
                    {signed(r.ic, 3)}{r.se !== null && <span className="text-ink-500"> ± {deNumber(r.se, 3)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-ink-800 px-4 py-2 text-xs leading-relaxed text-ink-500">
        IC je Hälfte farbig, wo er mindestens einen Standardfehler von null entfernt liegt. {' '}
        {unmeasured.map((r) => `${r.label} (${share(r.judgment)})`).join(' und ')}: im Backtest nicht messbar, sie behalten ihr
        Urteilsgewicht.
      </p>
    </section>
  );
}
