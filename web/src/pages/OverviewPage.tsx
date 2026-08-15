import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { OverviewRow } from '../types';
import StockLogo, { initialsFromName } from '../components/StockLogo';
import ScoreSparkline from '../components/charts/ScoreSparkline';
import RecommendationBadge from '../components/RecommendationBadge';
import { fmtBig, fmtPercentPoints, fmtPrice, relativeTime, upsideColor } from '../format';

interface Props {
  onSelect: (symbol: string) => void;
  /** Bumped by the parent after a run finishes so the table refetches. */
  refreshKey?: number;
}

type SortKey = 'score' | 'target' | 'composite' | 'symbol' | 'marketCap';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'score',      label: 'AI-Score' },
  { key: 'target',     label: 'Analysten-Potenzial' },
  { key: 'composite',  label: 'Modell-Potenzial' },
  { key: 'marketCap',  label: 'Marktkapitalisierung' },
  { key: 'symbol',     label: 'Symbol' },
];

/** Nulls always sink, whatever the column — an empty cell is not a low value. */
function byNumberDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function scoreColor(score: number | null): string {
  if (score === null) return 'text-ink-500';
  if (score >= 7) return 'text-emerald-400';
  if (score >= 5) return 'text-amber-400';
  return 'text-red-400';
}

export default function OverviewPage({ onSelect, refreshKey = 0 }: Props) {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('score');
  const [onlyWatched, setOnlyWatched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listOverview()
      .then((r) => { if (!cancelled) { setRows(r.rows); setError(null); } })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const visible = useMemo(() => {
    const list = onlyWatched ? rows.filter((r) => r.watched) : rows;
    const sorted = [...list];
    switch (sort) {
      case 'score':     sorted.sort((a, b) => byNumberDesc(a.aiScore, b.aiScore)); break;
      case 'target':    sorted.sort((a, b) => byNumberDesc(a.targetUpsidePct, b.targetUpsidePct)); break;
      case 'composite': sorted.sort((a, b) => byNumberDesc(a.compositeUpsidePct, b.compositeUpsidePct)); break;
      case 'marketCap': sorted.sort((a, b) => byNumberDesc(a.marketCap, b.marketCap)); break;
      case 'symbol':    sorted.sort((a, b) => a.symbol.localeCompare(b.symbol)); break;
    }
    return sorted;
  }, [rows, sort, onlyWatched]);

  const scored = rows.filter((r) => r.aiScore !== null);
  const avgScore = scored.length
    ? scored.reduce((sum, r) => sum + (r.aiScore ?? 0), 0) / scored.length
    : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-900 px-4 py-2">
        <h2 className="text-sm font-semibold text-ink-100">
          Übersicht <span className="text-ink-500">({visible.length})</span>
        </h2>
        {avgScore !== null && (
          <span className="text-[11px] text-ink-500">
            Ø Score <span className={scoreColor(avgScore)}>{avgScore.toFixed(1)}</span> über {scored.length} bewertete
          </span>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-400">
          <input
            type="checkbox"
            checked={onlyWatched}
            onChange={(e) => setOnlyWatched(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          nur Watchlist
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-400">
          Sortierung
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded border border-ink-700 bg-ink-950 px-2 py-1 text-[11px] text-ink-200 focus:border-accent focus:outline-none"
          >
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>

      {error && (
        <div className="border-b border-red-700 bg-red-950 px-4 py-2 text-sm text-red-400">⚠ {error}</div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-500">Lade Übersicht…</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-500">
            Noch keine Aktien im Cache — analysiere eine im Tab „Analyse“.
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-ink-900 text-[10px] uppercase tracking-wider text-ink-500">
              <tr className="border-b border-ink-700">
                <th className="px-3 py-2 text-left font-semibold">Aktie</th>
                <th className="px-2 py-2 text-right font-semibold">Score</th>
                <th className="px-2 py-2 text-left font-semibold">Verlauf</th>
                <th className="px-2 py-2 text-left font-semibold">Verdict</th>
                <th className="px-2 py-2 text-right font-semibold">Kurs</th>
                <th className="px-2 py-2 text-right font-semibold" title="Analysten-Konsensziel und Abstand zum Kurs">
                  Ø Ziel
                </th>
                <th className="px-2 py-2 text-right font-semibold" title="Composite Fair Value der Bewertungsmodelle">
                  Modell-FV
                </th>
                <th className="px-2 py-2 text-right font-semibold">MCap</th>
                <th className="px-3 py-2 text-right font-semibold">Aktualität</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.symbol}
                  onClick={() => onSelect(r.symbol)}
                  className="cursor-pointer border-b border-ink-800 transition hover:bg-ink-800"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <StockLogo
                        domain={r.logoDomain}
                        symbol={r.symbol}
                        fallbackInitials={initialsFromName(r.companyName)}
                        size={22}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-ink-100">{r.companyName}</span>
                          {!r.watched && (
                            <span
                              className="rounded border border-ink-700 px-1 text-[9px] uppercase text-ink-500"
                              title="Nicht in der Watchlist — wird vom nächtlichen Lauf übersprungen"
                            >
                              pausiert
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-[10px] text-ink-500">
                          {r.symbol}{r.sector ? ` · ${r.sector}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className={`px-2 py-2 text-right font-mono text-base font-semibold tabular ${scoreColor(r.aiScore)}`}>
                    {r.aiScore === null ? '—' : r.aiScore.toFixed(1)}
                    {r.scoreDelta !== null && r.scoreDelta !== 0 && (
                      <span className={`ml-1 text-[10px] ${r.scoreDelta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {r.scoreDelta > 0 ? '▲' : '▼'}{Math.abs(r.scoreDelta).toFixed(1)}
                      </span>
                    )}
                  </td>

                  <td className="px-2 py-1">
                    <ScoreSparkline points={r.scoreHistory} />
                  </td>

                  <td className="px-2 py-2">
                    {r.recommendation ? (
                      <RecommendationBadge rec={r.recommendation} />
                    ) : (
                      <span className="text-[11px] text-ink-600">nicht analysiert</span>
                    )}
                    {r.verdictModel && (
                      <div className="font-mono text-[9px] text-ink-600">{r.verdictModel}</div>
                    )}
                  </td>

                  <td className="px-2 py-2 text-right font-mono text-xs tabular text-ink-200">
                    {fmtPrice(r.price)}
                  </td>

                  <td className="px-2 py-2 text-right font-mono text-xs tabular">
                    <div className="text-ink-300">{r.targetMean === null ? '—' : fmtPrice(r.targetMean)}</div>
                    <div className={`text-[10px] ${upsideColor(r.targetUpsidePct)}`}>{fmtPercentPoints(r.targetUpsidePct)}</div>
                  </td>

                  <td className="px-2 py-2 text-right font-mono text-xs tabular">
                    <div className="text-ink-300">
                      {r.compositeFairValue === null ? '—' : fmtPrice(r.compositeFairValue)}
                    </div>
                    <div className={`text-[10px] ${upsideColor(r.compositeUpsidePct)}`}>{fmtPercentPoints(r.compositeUpsidePct)}</div>
                  </td>

                  <td className="px-2 py-2 text-right font-mono text-xs tabular text-ink-400">
                    {fmtBig(r.marketCap)}
                  </td>

                  <td className="px-3 py-2 text-right text-[10px] text-ink-500">
                    <div title="Alter der Marktdaten">
                      {r.dataAgeHours === null
                        ? '—'
                        : r.dataAgeHours < 48
                          ? `${r.dataAgeHours.toFixed(0)}h`
                          : `${(r.dataAgeHours / 24).toFixed(0)}d`}
                    </div>
                    <div className="text-ink-600" title="Letztes AI-Verdict">
                      {r.verdictAt ? relativeTime(r.verdictAt) : '—'}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
