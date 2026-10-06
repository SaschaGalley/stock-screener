import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { VerdictEvidence as Evidence } from '../../../src/backtest/result';
import { positionIn } from '../../../src/backtest/fair-value';

let cached: Promise<Evidence | null> | null = null;

/** The newest backtest's verdict bands, fetched once a page load: the list asks for them on every row. */
export function useVerdictEvidence(): Evidence | null {
  const [data, setData] = useState<Evidence | null>(null);
  useEffect(() => {
    cached ??= api.getVerdictEvidence().catch(() => null);
    let live = true;
    void cached.then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, []);
  return data;
}

const pct = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1).replace('.', ',')} %`);
const months = (h: number) => (h === 12 ? '12 M' : `${h} M`);
/** Two standard errors from nothing: anything less is a direction, not evidence. */
const FIRM_T = 2;

/** One verdict's past, as a line for a tooltip: "1 M +0,2 % · 6 M −2,5 % …". */
export function evidenceLine(e: Evidence, verdict: string): string | null {
  const rows = e.verdicts.filter((r) => r.bucket === verdict).sort((a, b) => a.horizon - b.horizon);
  if (!rows.length) return null;
  return `Im Backtest gegenüber der Durchschnittsaktie: ${rows.map((r) => `${months(r.horizon)} ${pct(r.meanExcess)}`).join(' · ')}`;
}

/**
 * What a verdict did before: the newest backtest's stocks with the same
 * factor verdict, against the average stock of the same month, one, three,
 * six and twelve months on. Beside the verdict so that it does not promise
 * more than it has delivered — a STRONG BUY ahead after a month and behind
 * after six is a different statement from one ahead after both.
 */
export default function VerdictEvidence({ verdict }: { verdict: string }) {
  const e = useVerdictEvidence();
  if (!e) return null;
  const rows = e.verdicts.filter((r) => r.bucket === verdict).sort((a, b) => a.horizon - b.horizon);
  if (!rows.length) return null;
  const firm = rows.some((r) => r.tStat !== null && Math.abs(r.tStat) >= FIRM_T);

  const first = rows[0], last = rows[rows.length - 1];
  return (
    <EvidenceFold
      summary={<>
        Im Backtest lag {verdict} nach {months(first.horizon)} {pct(first.meanExcess)}
        {last !== first && <>, nach {months(last.horizon)} {pct(last.meanExcess)}</>} gegenüber der Durchschnittsaktie —{' '}
        <span className={firm ? 'text-ink-200' : ''}>{firm ? 'belegt' : 'kein Beleg'}</span>
      </>}
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {rows.map((r) => {
          const solid = r.tStat !== null && Math.abs(r.tStat) >= FIRM_T;
          const color = r.meanExcess === null ? 'text-ink-500' : r.meanExcess >= 0 ? 'text-emerald-400' : 'text-red-400';
          return (
            <div
              key={r.horizon}
              title={`t ${r.tStat?.toFixed(1).replace('.', ',') ?? '—'} · ${r.count.toLocaleString('de-DE')} Fälle in ${r.months} Monaten`
                + (r.hitRate !== null ? ` · in ${Math.round(r.hitRate * 100)} % der Monate vorn` : '')}
            >
              <div className="text-2xs text-ink-500">{months(r.horizon)}</div>
              <div className={`font-mono text-sm ${color} ${solid ? 'font-semibold' : 'opacity-70'}`}>{pct(r.meanExcess)}</div>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-2xs leading-snug text-ink-500">
        Aktien mit demselben Faktor-Urteil, {e.universe} {e.from.slice(0, 4)}–{e.to.slice(0, 4)}, gegen die Durchschnittsaktie
        desselben Monats.{' '}
        {firm ? 'Fett: mindestens zwei Standardfehler von null.' : 'Kein Wert liegt zwei Standardfehler von null — eine Richtung, kein Beleg.'}
        {e.fidelity?.rho != null && <> Der nachgebaute Score folgt dem der App mit einer Rangkorrelation von {e.fidelity.rho.toFixed(2).replace('.', ',')}.</>}
      </p>
    </EvidenceFold>
  );
}

/**
 * The backtest beside a headline number, as one line that already says the
 * result, and the full reading on a click. In the verdict card the reading
 * took more room than the verdict; the line keeps its point — whether the
 * number has earned anything — where the eye is. Not remembered.
 */
function EvidenceFold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 rounded border border-ink-800 bg-ink-950 px-3 py-1.5 text-2xs leading-snug">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-1.5 text-left text-ink-400 transition hover:text-ink-200"
      >
        <span className={`mt-px inline-block w-2 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span>{summary}</span>
      </button>
      {open && <div className="mt-1.5 pl-3.5 text-ink-400">{children}</div>}
    </div>
  );
}

/** Where today's price stands, as a sentence says it. */
const WHERE: Record<string, string> = {
  'unter der Spanne': 'unter allen Modellwerten',
  'unteres Viertel':  'im unteren Viertel der Modellspanne',
  'mittlere Hälfte':  'in der mittleren Hälfte der Modellspanne',
  'oberes Viertel':   'im oberen Viertel der Modellspanne',
  'über der Spanne':  'über allen Modellwerten',
};

/**
 * What the margin of safety meant in the backtest, under the fair value:
 * whether the gap ranked the returns that followed, how much of it the price
 * closed, and what a price where today's stands in the models' range earned.
 * Beside the margin so that it does not read as an expected return.
 */
export function FairValueEvidence({ price, primary }: {
  price: number;
  primary: { min: number | null; p25: number | null; p75: number | null; max: number | null };
}) {
  const e = useVerdictEvidence();
  const fair = e?.fair;
  if (!fair || !fair.ics.length) return null;
  const ics = [...fair.ics].sort((a, b) => a.horizon - b.horizon);
  const firm = ics.filter((r) => r.t !== null && Math.abs(r.t) >= FIRM_T);
  const year = fair.closed.find((r) => r.horizon === 12);
  const position = positionIn(price, primary);
  const there = position ? fair.positions.find((r) => r.bucket === position && r.horizon === 12) : null;
  const ic = (v: number | null) => (v === null ? '—' : v.toFixed(3).replace('.', ',').replace('-', '−'));

  return (
    <EvidenceFold
      summary={<>
        Im Backtest sagte die Lücke zum fairen Wert{' '}
        <span className={firm.length ? 'text-ink-200' : ''}>
          {firm.length ? `die Rendite bei ${firm.map((r) => months(r.horizon)).join(', ')} voraus` : 'keine Rendite voraus'}
        </span>
      </>}
    >
      <p>
        {firm.length
          ? <>Die Lücke zum fairen Wert sagte die Rendite bei {firm.map((r) => months(r.horizon)).join(', ')} voraus. </>
          : <>Die Lücke zum fairen Wert sagte keine Rendite voraus. </>}
        <span className="font-mono" title="Rang-IC der Lücke über 1, 3, 6 und 12 Monate">
          IC {ics.map((r) => ic(r.ic)).join(' · ')}
        </span>
        {year?.slope != null && <>; in einem Jahr schloss der Kurs im Schnitt {(year.slope * 100).toFixed(1).replace('.', ',')} % der Lücke.</>}
      </p>
      {position && there && (
        <p className="mt-1">
          Der Kurs steht heute {WHERE[position]}. So gestellte Aktien lagen nach zwölf Monaten{' '}
          <span className={`font-mono ${there.meanExcess !== null && there.meanExcess >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {pct(there.meanExcess)}
          </span>{' '}
          gegenüber der Durchschnittsaktie (t {there.tStat?.toFixed(1).replace('.', ',').replace('-', '−') ?? '—'}).
        </p>
      )}
      <p className="mt-1 text-ink-500">Die Marge beschreibt die Modelle, sie ist keine erwartete Rendite.</p>
    </EvidenceFold>
  );
}
