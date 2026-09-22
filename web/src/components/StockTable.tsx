import type { MutableRefObject } from 'react';
import type { OverviewRow } from '../types';
import ScoreSparkline from './charts/ScoreSparkline';
import RecommendationBadge from './RecommendationBadge';
import StockListControls from './StockListControls';
import { StockIdentity, StockScore, rowTitle, ROW_HEIGHT, HEADER_HEIGHT } from './StockRowCells';
import { useListScroll, type ListScrollAnchor } from './useListScroll';
import { ChartIcon, GearIcon } from './icons';
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
  onSelect: (symbol: string) => void;
  onOpenAdmin: () => void;
  onOpenEvaluation: () => void;
  /** Symbol → stages the queue currently has in flight for it. */
  activity?: Record<string, string[]>;
  /** Shared with the rail, so collapsing the columns doesn't move the list. */
  scrollAnchor: MutableRefObject<ListScrollAnchor>;
}

/**
 * The stock list at full width: every column the overview has room for.
 *
 * Its narrow twin is `StockRail`, and the two columns they share come from
 * `StockRowCells` so they are the same markup at the same height. The rest of
 * the row is free to stack — a fair value over its distance from the price is
 * one fact, and reads better as one cell than as two columns.
 */
export default function StockTable({
  rows, total, loading, view, onViewChange, onSelect, onOpenAdmin, onOpenEvaluation,
  activity = {}, scrollAnchor,
}: Props) {
  // The table only exists while it is on screen, so it is always the visible
  // one — and nothing is selected while it is: closing the analysis deselects.
  // Its column labels are sticky, so they hide the first row or so.
  const { containerRef, onScroll } = useListScroll(
    scrollAnchor, true, null, rows.length,
    (el) => el.querySelector('thead')?.getBoundingClientRect().height ?? 0,
  );

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
        <div className="ml-auto flex items-center gap-3">
          <StockListControls view={view} onChange={onViewChange} layout="bar" />
          <button
            onClick={onOpenEvaluation}
            title="Auswertung — sagt der Score die spätere Rendite voraus?"
            className="rounded p-1 text-ink-400 transition hover:bg-ink-800 hover:text-ink-200"
          >
            <ChartIcon />
          </button>
          <button
            onClick={onOpenAdmin}
            title="Administration — Cronjobs, Watchlist, Modelle"
            className="rounded p-1 text-ink-400 transition hover:bg-ink-800 hover:text-ink-200"
          >
            <GearIcon />
          </button>
        </div>
      </div>

      <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-auto">
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
              <tr className={`${HEADER_HEIGHT} border-b border-ink-700`}>
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
                return (
                  <tr
                    key={r.symbol}
                    data-stock-row
                    data-symbol={r.symbol}
                    onClick={() => onSelect(r.symbol)}
                    title={rowTitle(r, fmtBig)}
                    className={`${ROW_HEIGHT} cursor-pointer border-b border-ink-800 transition hover:bg-ink-800`}
                  >
                    <td className="py-2 pr-2 pl-3">
                      <StockIdentity row={r} active={false} stages={activity[r.symbol]} />
                    </td>

                    <td className="px-2 py-2 text-right">
                      <StockScore row={r} split />
                    </td>

                    <td className="px-2 py-1">
                      <ScoreSparkline points={r.scoreHistory} />
                    </td>

                    <td className="px-2 py-2">
                      {r.recommendation ? (
                        <RecommendationBadge
                          rec={r.recommendation}
                          score={r.score}
                          heldBack={r.verdictCapped ? r.capReasons : []}
                        />
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
