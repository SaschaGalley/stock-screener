import { useEffect, useRef } from 'react';
import type { OverviewRow } from '../types';
import StockLogo, { initialsFromName } from './StockLogo';
import ScoreSparkline from './charts/ScoreSparkline';
import RecommendationBadge from './RecommendationBadge';
import StockListControls from './StockListControls';
import { averageScore, scoreColor, type ListView } from './stockList';
import { fmtBig, fmtPercentPoints, fmtPrice, relativeTime, upsideColor } from '../format';

interface Props {
  /** Already filtered and sorted — see `applyListView`. */
  rows:  OverviewRow[];
  /** How many stocks exist before filtering, so the header can say "x von y". */
  total: number;
  loading: boolean;
  view:     ListView;
  onViewChange: (next: ListView) => void;
  /** Kept highlighted while the analysis is open, so returning shows your place. */
  selectedSymbol: string | null;
  onSelect: (symbol: string) => void;
}

/**
 * The stock list at full width: every column the overview has room for.
 *
 * Its narrow twin is `StockRail`. Both render the rows `applyListView` hands
 * them, in that order — this one just has the space to also show the price,
 * the targets and the sparkline.
 */
export default function StockTable({
  rows, total, loading, view, onViewChange, selectedSymbol, onSelect,
}: Props) {
  const selectedRef = useRef<HTMLTableRowElement | null>(null);

  // Coming back from an analysis, put the stock you were just reading back
  // under your eyes rather than at whatever offset the list happens to open at.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' });
    // Mount only: re-running on every selection change would yank the list
    // around while the user is scrolling it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const avg = averageScore(rows);
  const filtered = rows.length !== total;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-900 px-4 py-2">
        <h2 className="text-sm font-semibold text-ink-100">
          Übersicht{' '}
          <span className="text-ink-500">
            ({rows.length}{filtered ? ` von ${total}` : ''})
          </span>
        </h2>
        {avg && (
          <span className="text-[11px] text-ink-500">
            Ø Score <span className={scoreColor(avg.avg)}>{avg.avg.toFixed(1)}</span> über {avg.count} bewertete
          </span>
        )}
        <div className="ml-auto">
          <StockListControls view={view} onChange={onViewChange} layout="row" />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && total === 0 ? (
          <div className="p-8 text-center text-sm text-ink-500">Lade Übersicht…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-500">
            {total === 0
              ? 'Noch keine Aktien im Cache — unten eine hinzufügen.'
              : 'Keine Treffer für diesen Filter.'}
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
              {rows.map((r) => {
                const active = r.symbol === selectedSymbol;
                return (
                  <tr
                    key={r.symbol}
                    ref={active ? selectedRef : undefined}
                    onClick={() => onSelect(r.symbol)}
                    className={`cursor-pointer border-b border-ink-800 transition ${
                      active ? 'bg-accent-soft' : 'hover:bg-ink-800'
                    }`}
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
                      {fmtPrice(r.price, r.currency)}
                    </td>

                    <td className="px-2 py-2 text-right font-mono text-xs tabular">
                      <div className="text-ink-300">{r.targetMean === null ? '—' : fmtPrice(r.targetMean, r.currency)}</div>
                      <div className={`text-[10px] ${upsideColor(r.targetUpsidePct)}`}>{fmtPercentPoints(r.targetUpsidePct)}</div>
                    </td>

                    <td className="px-2 py-2 text-right font-mono text-xs tabular">
                      <div className="text-ink-300">
                        {r.compositeFairValue === null ? '—' : fmtPrice(r.compositeFairValue, r.currency)}
                      </div>
                      <div className={`text-[10px] ${upsideColor(r.compositeUpsidePct)}`}>{fmtPercentPoints(r.compositeUpsidePct)}</div>
                    </td>

                    <td className="px-2 py-2 text-right font-mono text-xs tabular text-ink-400">
                      {fmtBig(r.marketCap, r.currency)}
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
