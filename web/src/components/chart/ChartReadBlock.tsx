import { useState } from 'react';
import { api } from '../../api';
import { CHART_PATTERN_STATUS_LABEL, type ChartRead, type ChartReadDoc } from '../../../../src/analysis/chart';
import { MODELS } from '../../../../src/models';
import { modelName, useTaskModels } from '../../models';
import PriceLadder, { type LadderMark } from './PriceLadder';
import { Question, dayDe, de } from './shared';
import { deProse } from '../prose';

const CASE = {
  bull: { label: 'Bull', title: 'Nach oben', cls: 'border-emerald-800', text: 'text-emerald-300' },
  base: { label: 'Basis', title: 'Seitwärts', cls: 'border-ink-700', text: 'text-ink-200' },
  bear: { label: 'Bear', title: 'Nach unten', cls: 'border-red-800', text: 'text-red-300' },
} as const;
const ORDER = ['bull', 'base', 'bear'] as const;
const STRENGTH = { strong: { word: 'stark', n: 1 }, medium: { word: 'mittel', n: 0.55 }, weak: { word: 'schwach', n: 0.2 } } as const;
const DIRECTION = { up: 'aufwärts', down: 'abwärts', sideways: 'seitwärts' } as const;

/** Readings stored before the prompt asked for German text wrote 2026-09-17 and 345.34 USD. */
const deDates = deProse;

export function readFinding(r: ChartRead): string {
  return [`Trend ${DIRECTION[r.trend.direction]}`, r.trend.phase, r.patterns[0] && `${r.patterns[0].name} ${CHART_PATTERN_STATUS_LABEL[r.patterns[0].status]}`]
    .filter(Boolean).join(' · ');
}

/** The model's levels and the scenarios' targets on the ladder, the comments on hover. */
function readMarks(r: ChartRead): LadderMark[] {
  const marks: LadderMark[] = r.levels.map((l) => ({
    price: l.price, kind: l.kind, label: l.kind === 'support' ? 'Unterstützung' : 'Widerstand',
    note: STRENGTH[l.strength].word, strength: STRENGTH[l.strength].n,
    tip: <div className="max-w-xs text-ink-300">{deDates(l.comment)}</div>,
  }));
  for (const s of r.scenarios) {
    if (s.target === null) continue;
    marks.push({ price: s.target, kind: 'target', label: `Ziel ${CASE[s.case].label}`, tip: <div className="max-w-xs text-ink-300">{deDates(s.trigger)}</div> });
  }
  for (const p of r.patterns) {
    if (p.trigger !== null) marks.push({ price: p.trigger, kind: 'neutral', label: 'Auslöser des Musters', tip: p.name });
  }
  return marks;
}

/**
 * A language model's reading of the chart: what it sees in a paragraph, the
 * three ways it can go — each with its trigger and where it would lead — and
 * the model's own levels on the same ladder as the computed ones. The
 * comments that made the table of levels a wall of text are on hover.
 */
export default function ChartReadBlock({ symbol, read, price, asOf, fmtPrice, onRead }: {
  symbol: string; read: ChartReadDoc | null; price: number; asOf: string | null;
  fmtPrice: (n: number) => string; onRead: (r: ChartReadDoc) => void;
}) {
  // '' is the administration's model; another is picked for one reading — not through the LiteLLM proxy, which chooses.
  const [pick, setPick] = useState('');
  const models = useTaskModels();
  const standard = models?.chartRead ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try { onRead(await api.runChartRead(symbol, pick || null)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const r = read?.read ?? null;
  const stale = r && asOf && r.asOf < asOf;
  const label = (id: string | null) => MODELS.find((m) => m.id === id)?.label ?? id ?? '—';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {read && (
          <span className="text-xs text-ink-500">
            {label(read.model)} · {new Date(read.producedAt).toLocaleDateString('de-DE')} · Kurse bis {dayDe(read.read.asOf)}
            {stale && <span className="text-amber-300/80"> · neuere Kurse liegen vor</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {models?.gateway ? (
            <span className="text-2xs text-ink-500" title={`Über den LiteLLM-Proxy (${models.gateway}), Aufgabe stock-cli/chart-read`}>{modelName(standard)}</span>
          ) : (
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            disabled={busy}
            className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-xs text-ink-200"
          >
            <option value="">Vorgabe{standard ? ` (${label(standard)})` : ''}</option>
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          )}
          <button
            onClick={() => void run()}
            disabled={busy}
            className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-xs text-ink-100 transition hover:bg-ink-700 disabled:opacity-50"
          >
            {busy ? 'liest den Chart …' : r ? '↻ Neu lesen' : 'Chart lesen lassen'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">⚠ {error}</p>}
      {!r && !busy && !error && (
        <p className="text-sm text-ink-400">
          Ein Sprachmodell bekommt zwei Jahre Wochenkerzen, das letzte Quartal in Tageskerzen und die berechneten Marken, und
          sucht Chartmuster, wichtige Marken und Szenarien mit Auslösern. Eine Anfrage, je nach Modell einige Sekunden bis zwei Minuten.
        </p>
      )}
      {busy && !r && <p className="text-sm text-ink-500">Das Modell liest den Chart — je nach Modell bis zu zwei Minuten.</p>}

      {r && (
        <div className={`space-y-5 ${busy ? 'opacity-50' : ''}`}>
          <div>
            <p className="text-[15px] leading-relaxed text-ink-100">{deDates(r.summary)}</p>
            <p className="mt-1.5 text-sm text-ink-400">
              Trend <span className="text-ink-200">{DIRECTION[r.trend.direction]}</span>
              {r.trend.phase && <> · <span className="text-ink-200">{r.trend.phase}</span></>}
              {r.trend.comment && <> — {deDates(r.trend.comment)}</>}
            </p>
          </div>

          {r.scenarios.length > 0 && (
            <div>
              <Question>Wie es weitergehen kann</Question>
              <div className="grid gap-3 md:grid-cols-3">
                {ORDER.flatMap((c) => r.scenarios.filter((s) => s.case === c)).map((s, k) => (
                  <div key={k} className={`rounded-lg border bg-ink-950 px-3 py-2.5 ${CASE[s.case].cls}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`text-sm font-semibold ${CASE[s.case].text}`}>{CASE[s.case].title}</span>
                      {s.target !== null && (
                        <span className="whitespace-nowrap font-mono text-sm text-ink-100">
                          {fmtPrice(s.target)} <span className="text-xs text-ink-500">{`${s.target >= price ? '+' : '−'}${de(Math.abs((s.target / price - 1) * 100), 1)} %`}</span>
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 text-[13px] text-ink-200"><span className="text-ink-500">Auslöser: </span>{deDates(s.trigger)}</div>
                    {s.comment && <div className="mt-1 text-[13px] text-ink-400">{deDates(s.comment)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {(r.levels.length > 0 || r.scenarios.some((s) => s.target !== null)) && (
              <div>
                <Question note="Begründungen beim Überfahren">Marken laut Modell</Question>
                <PriceLadder price={price} marks={readMarks(r)} fmt={fmtPrice} />
              </div>
            )}
            <div className="space-y-5">
              {r.patterns.length > 0 && (
                <div>
                  <Question>Muster</Question>
                  <ul className="space-y-3">
                    {r.patterns.map((p, k) => (
                      <li key={k}>
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-semibold text-ink-100">{p.name}</span>
                          <span className={`rounded border px-1 text-2xs ${p.status === 'confirmed' ? 'border-emerald-800 text-emerald-300' : p.status === 'failed' ? 'border-red-800 text-red-300' : 'border-ink-700 text-ink-400'}`}>
                            {CHART_PATTERN_STATUS_LABEL[p.status]}
                          </span>
                          {p.from && <span className="text-xs text-ink-500">{dayDe(p.from)}{p.to ? `–${dayDe(p.to)}` : ''}</span>}
                        </div>
                        {(p.trigger !== null || p.target !== null) && (
                          <div className="text-[13px] text-ink-300">
                            {p.trigger !== null && <>Auslöser <span className="font-mono text-ink-100">{fmtPrice(p.trigger)}</span></>}
                            {p.trigger !== null && p.target !== null && ' · '}
                            {p.target !== null && <>Ziel <span className="font-mono text-ink-100">{fmtPrice(p.target)}</span></>}
                          </div>
                        )}
                        {p.comment && <div className="text-[13px] leading-snug text-ink-400">{deDates(p.comment)}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.invalidation && (
                <div>
                  <Question>Widerlegt, wenn</Question>
                  <p className="text-[13px] text-ink-300">{deDates(r.invalidation)}</p>
                </div>
              )}
              {r.watch.length > 0 && (
                <div>
                  <Question>Worauf achten</Question>
                  <ul className="list-disc space-y-1 pl-4 text-[13px] text-ink-300">{r.watch.map((w, k) => <li key={k}>{deDates(w)}</li>)}</ul>
                </div>
              )}
            </div>
          </div>
          <p className="text-2xs text-ink-500">
            Lesart eines Sprachmodells aus Kursdaten allein. Chartmuster sind in dieser App nicht backtestet, und Modelle sehen Muster
            auch dort, wo keine sind. Keine Anlageberatung.
          </p>
        </div>
      )}
    </div>
  );
}
