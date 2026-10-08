import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import RecommendationBadge from './RecommendationBadge';
import StockLogo, { initialsFromName } from './StockLogo';
import Tip from './Tip';
import { scoreColor } from './stockList';
import { deNumber } from '../format';
import type { DepotCheckResponse } from '../../../src/api-types';
import type { CheckedStock, ManagerAction } from '../../../src/analysis/depot-check';

const fmtTime = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const pct = (x: number) => `${deNumber(x * 100, 1)} %`;
const score = (x: number) => deNumber(x, 1);
const TREND: Record<'up' | 'down' | 'sideways', { mark: string; label: string; cls: string }> = {
  up:       { mark: '↗', label: 'Chart steigt', cls: 'text-emerald-400' },
  down:     { mark: '↘', label: 'Chart fällt', cls: 'text-red-400' },
  sideways: { mark: '→', label: 'Chart seitwärts', cls: 'text-ink-400' },
};
const ACTION: Record<ManagerAction, string> = {
  kaufen: 'text-emerald-400', aufstocken: 'text-emerald-400', reduzieren: 'text-red-400', verkaufen: 'text-red-400',
  halten: 'text-ink-300', beobachten: 'text-amber-300',
};

/**
 * The depot check on the depot page: one button, and what came of the last
 * run. Answer first — what to look at buying, what to look at reducing — then
 * what a depot manager would make of it. Possibilities, said as such.
 */
export default function DepotCheck({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [data, setData] = useState<DepotCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.getDepotCheck().then(setData).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const running = data?.status?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(reload, 5_000);
    return () => window.clearInterval(t);
  }, [running, reload]);

  async function run() {
    setError(null);
    try {
      const r = await api.runDepotCheck();
      if (!r.started) setError(r.reason ?? 'Depot-Check nicht gestartet.');
    } catch (e) {
      setError((e as Error).message);
    }
    reload();
  }

  const s = data?.settings;
  const st = data?.status ?? null;
  const r = data?.result ?? null;
  const name = (c: CheckedStock) => c.name ?? c.symbol;

  return (
    <section className="rounded-lg border border-ink-800 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink-100">Depot-Check</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
            {s
              ? <>Analysiert die bis zu {s.maxCandidates} besten Aktien außerhalb des Depots ab Score {score(s.minScore)} — aus der
                Liste und dem Universum — samt Chart, liest die Charts der Depotwerte unter {score(s.reduceBelow)} und fragt dann ein
                Modell, was ein Depotmanager tun würde. Möglichkeiten zum Prüfen, keine Anlageberatung.</>
              : 'Lädt …'}
          </p>
        </div>
        <button
          onClick={() => void run()}
          disabled={running || !data}
          className="shrink-0 rounded bg-accent px-3 py-1.5 text-sm font-medium text-ink-950 transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? 'Prüft …' : 'Depot prüfen'}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">⚠ {error}</p>}
      {st && running && (
        <p className="mt-2 text-xs text-amber-300">
          Läuft seit {fmtTime(st.startedAt)}{st.total > 0 && <> · {st.done}/{st.total}</>}{st.phase && <> · {st.phase}</>}
          {st.total > 0 && (
            <span className="mt-1 block h-1 w-full overflow-hidden rounded bg-ink-800">
              <span className="block h-full bg-amber-400 transition-all" style={{ width: `${(st.done / st.total) * 100}%` }} />
            </span>
          )}
        </p>
      )}
      {st && (st.state === 'failed' || st.state === 'interrupted') && (
        <p className="mt-2 text-xs text-red-400">
          {st.state === 'interrupted' ? 'Abgebrochen' : 'Fehlgeschlagen'}{st.finishedAt && ` ${fmtTime(st.finishedAt)}`}{st.error && ` — ${st.error}`}
        </p>
      )}

      {r && (
        <div className="mt-3 space-y-4 border-t border-ink-800 pt-3">
          <div className="grid gap-4 md:grid-cols-2">
            <List
              title="Kaufen ansehen" tone="text-emerald-400" rows={r.lists.buy} onOpen={onOpen}
              empty={`Keine Aktie hält ${score(r.settings.minScore)} nach der Analyse und hat einen steigenden Chart.`}
              hint="Außerhalb des Depots: Score nach der Analyse noch über der Schwelle, Urteil BUY oder STRONG BUY, Chart steigt."
            />
            <List
              title="Reduzieren ansehen" tone="text-red-400" rows={r.lists.reduce} onOpen={onOpen} showWeight
              empty={`Kein Depotwert unter ${score(r.settings.reduceBelow)} mit fallendem Chart.`}
              hint="Im Depot: Score unter der Schwelle und der Chart fällt."
            />
            <List
              title="Hoch bewertet, Chart noch nicht" tone="text-ink-200" rows={r.lists.waitForChart} onOpen={onOpen}
              hint="Score hält, aber der Chart steigt nicht — oder das Urteil wurde zurückgehalten."
            />
            <List
              title="Schwach bewertet, Chart hält" tone="text-ink-200" rows={r.lists.watch} onOpen={onOpen} showWeight
              hint="Im Depot unter der Schwelle, der Chart fällt aber nicht."
            />
          </div>

          {(r.lists.dropped.length > 0 || r.candidates.some((c) => c.error)) && (
            <p className="text-xs text-ink-500">
              {r.lists.dropped.length > 0 && (
                <>Nach der Analyse unter {score(r.settings.minScore)}: {r.lists.dropped.map((c) => `${name(c)} (${c.score === null ? '—' : score(c.score)})`).join(', ')}. </>
              )}
              {r.candidates.filter((c) => c.error).length > 0 && (
                <Tip content={r.candidates.filter((c) => c.error).map((c) => `${c.symbol}: ${c.error}`).join('\n')}>
                  <span className="underline decoration-dotted">Bei {r.candidates.filter((c) => c.error).length} ging etwas schief.</span>
                </Tip>
              )}
            </p>
          )}

          <div>
            <h4 className="mb-1 text-xs font-semibold text-ink-300">Was ein Depotmanager tun würde</h4>
            {r.manager ? (
              <div className="space-y-2 text-sm leading-relaxed text-ink-200">
                <p>{r.manager.summary}</p>
                {r.manager.moves.length > 0 && (
                  <ul className="space-y-1">
                    {r.manager.moves.map((m, i) => (
                      <li key={`${m.symbol}-${i}`} className="flex gap-2">
                        <span className={`w-24 shrink-0 text-xs font-semibold uppercase tracking-wide ${ACTION[m.action]}`}>{m.action}</span>
                        <span className="min-w-0">
                          <button onClick={() => onOpen(m.symbol)} className="font-mono text-xs text-ink-300 hover:text-ink-100">{m.symbol}</button>
                          {' '}— {m.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {r.manager.risks.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-400">
                    {r.manager.risks.map((x, i) => <li key={i}>{x}</li>)}
                  </ul>
                )}
              </div>
            ) : (
              <p className="text-xs text-ink-500">Kein Text{r.managerError ? `: ${r.managerError}` : '.'}</p>
            )}
          </div>

          <p className="text-2xs text-ink-500">
            Geprüft {fmtTime(r.generatedAt)} mit {r.model} · {r.candidates.length} Kandidaten ab {score(r.settings.minScore)},{' '}
            {r.holdings.length} Depotwerte unter {score(r.settings.reduceBelow)}. Das Modell bekommt Namen, Sektoren und Gewichte in
            Prozent, keine Stückzahlen, Kaufkurse oder Beträge. Keine Anlageberatung.
          </p>
        </div>
      )}
    </section>
  );
}

function List({ title, tone, rows, hint, empty, showWeight = false, onOpen }: {
  title: string; tone: string; rows: CheckedStock[]; hint: string; empty?: string; showWeight?: boolean;
  onOpen: (symbol: string) => void;
}) {
  if (rows.length === 0 && !empty) return null;
  return (
    // A grid cell shrinks below its content only when told to, and the names truncate only once it does.
    <div className="min-w-0">
      <h4 className={`mb-1 text-xs font-semibold ${tone}`}>
        <Tip content={hint}><span>{title}</span></Tip>
        {rows.length > 0 && <span className="ml-1 font-normal text-ink-500">({rows.length})</span>}
      </h4>
      {rows.length === 0 ? <p className="text-xs text-ink-500">{empty}</p> : (
        <ul className="-mx-2">
          {rows.map((c) => {
            const t = c.chart ? TREND[c.chart.trend] : null;
            return (
              <li key={c.symbol}>
                <button
                  onClick={() => onOpen(c.symbol)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition hover:bg-ink-800"
                >
                  <StockLogo symbol={c.symbol} domain={null} fallbackInitials={initialsFromName(c.name ?? c.symbol)} size={18} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-100">
                    {c.name ?? c.symbol} <span className="font-mono text-2xs text-ink-500">{c.symbol}</span>
                  </span>
                  {showWeight && c.weight !== null && <span className="font-mono text-xs text-ink-400">{pct(c.weight)}</span>}
                  {t && (
                    <Tip focusable={false} content={c.chart ? `${t.label} (Stand ${c.chart.asOf}): ${c.chart.summary}` : t.label}>
                      <span className={`font-mono text-sm ${t.cls}`}>{t.mark}</span>
                    </Tip>
                  )}
                  {c.verdict && <RecommendationBadge rec={c.verdict} size="sm" />}
                  <Tip focusable={false} content={c.scoreBefore !== null && c.score !== null && c.scoreBefore !== c.score
                    ? `Vor der Analyse ${score(c.scoreBefore)}, danach ${score(c.score)}` : 'Score'}
                  >
                    <span className={`w-8 text-right font-mono text-sm font-semibold tabular ${c.score === null ? 'text-ink-500' : scoreColor(c.score)}`}>
                      {c.score === null ? '—' : score(c.score)}
                    </span>
                  </Tip>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
