import type { MutableRefObject } from 'react';
import type { OverviewRow } from '../types';
import ScoreSparkline from './charts/ScoreSparkline';
import RecommendationBadge from './RecommendationBadge';
import StockListControls from './StockListControls';
import { StockIdentity, StockScore, rowTitle } from './StockRowCells';
import { useListScroll, type ListScrollAnchor } from './useListScroll';
import { GearIcon } from './icons';
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
  onOpenAdmin: () => void;
  /** Symbol → stages the queue currently has in flight for it. */
  activity?: Record<string, string[]>;
  /** Shared with the rail, so collapsing the columns doesn't move the list. */
  scrollAnchor: MutableRefObject<ListScrollAnchor>;
}

/**
 * The stock list at full width: every column the overview has room for.
 *
 * Its narrow twin is `StockRail`, and the two columns they share come from
 * `StockRowCells` so they are the same markup at the same height. Everything
 * here is one line tall for that reason — the price and its upside sit beside
 * each other rather than stacked, which is also how you read them across a row.
 */
export default function StockTable({
  rows, total, loading, view, onViewChange, selectedSymbol, onSelect, onOpenAdmin,
  activity = {}, scrollAnchor,
}: Props) {
  // The table only exists while it is on screen, so it is always the visible one.
  const { containerRef, onScroll } = useListScroll(scrollAnchor, true, selectedSymbol, rows.length);

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
              <tr className="border-b border-ink-700">
                <th className="px-3 py-1.5 text-left font-semibold">Aktie</th>
                <th className="px-2 py-1.5 text-right font-semibold">Score</th>
                <th className="px-2 py-1.5 text-left font-semibold">Verlauf</th>
                <th className="px-2 py-1.5 text-left font-semibold">Verdict</th>
                <th className="px-2 py-1.5 text-right font-semibold">Kurs</th>
                <th className="px-2 py-1.5 text-right font-semibold" title="Analysten-Konsensziel und Abstand zum Kurs">
                  Ø Ziel
                </th>
                <th className="px-2 py-1.5 text-right font-semibold" title="Composite Fair Value der Bewertungsmodelle">
                  Modell-FV
                </th>
                <th className="px-2 py-1.5 text-right font-semibold">MCap</th>
                <th className="px-3 py-1.5 text-right font-semibold" title="Alter der Marktdaten · letztes AI-Verdict">
                  Aktualität
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const active = r.symbol === selectedSymbol;
                return (
                  <tr
                    key={r.symbol}
                    data-stock-row
                    data-symbol={r.symbol}
                    data-selected={active}
                    onClick={() => onSelect(r.symbol)}
                    title={rowTitle(r, fmtBig)}
                    className={`cursor-pointer border-b border-ink-800 transition ${
                      active ? 'bg-accent-soft' : 'hover:bg-ink-800'
                    }`}
                  >
                    <td className={`py-1 pr-2 pl-3 ${active ? 'border-l-2 border-l-accent pl-[10px]' : ''}`}>
                      <StockIdentity
                        row={r}
                        active={active}
                        stages={activity[r.symbol]}
                        showSector
                      />
                    </td>

                    <td className="px-2 py-1 text-right">
                      <StockScore row={r} />
                    </td>

                    <td className="px-2 py-1">
                      <ScoreSparkline points={r.scoreHistory} height={22} />
                    </td>

                    <td className="px-2 py-1">
                      <div className="flex items-center gap-1.5">
                        {r.recommendation ? (
                          <RecommendationBadge rec={r.recommendation} compact />
                        ) : (
                          <span className="text-[11px] text-ink-600">nicht analysiert</span>
                        )}
                        {r.verdictModel && (
                          <span className="truncate font-mono text-[9px] text-ink-600">{r.verdictModel}</span>
                        )}
                      </div>
                    </td>

                    <td className="px-2 py-1 text-right font-mono text-xs tabular text-ink-200">
                      {fmtPrice(r.price, r.currency)}
                    </td>

                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular">
                      <span className="text-ink-300">{r.targetMean === null ? '—' : fmtPrice(r.targetMean, r.currency)}</span>
                      <span className={`ml-1.5 text-[10px] ${upsideColor(r.targetUpsidePct)}`}>{fmtPercentPoints(r.targetUpsidePct)}</span>
                    </td>

                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular">
                      <span className="text-ink-300">
                        {r.compositeFairValue === null ? '—' : fmtPrice(r.compositeFairValue, r.currency)}
                      </span>
                      <span className={`ml-1.5 text-[10px] ${upsideColor(r.compositeUpsidePct)}`}>{fmtPercentPoints(r.compositeUpsidePct)}</span>
                    </td>

                    <td className="px-2 py-1 text-right font-mono text-xs tabular text-ink-400">
                      {fmtBig(r.marketCap, r.currency)}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1 text-right text-[10px] text-ink-500">
                      {r.dataAgeHours === null
                        ? '—'
                        : r.dataAgeHours < 48
                          ? `${r.dataAgeHours.toFixed(0)}h`
                          : `${(r.dataAgeHours / 24).toFixed(0)}d`}
                      <span className="text-ink-600"> · {r.verdictAt ? relativeTime(r.verdictAt) : '—'}</span>
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
