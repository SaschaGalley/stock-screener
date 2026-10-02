import { Fragment, type MutableRefObject } from 'react';
import type { OverviewRow } from '../types';
import ScoreSparkline from './charts/ScoreSparkline';
import RecommendationBadge from './RecommendationBadge';
import StockListControls from './StockListControls';
import Tip from './Tip';
import {
  StockIdentity, StockScore, GroupName, GroupAverage, rowTitle, ROW_HEIGHT, HEADER_HEIGHT, GROUP_HEIGHT,
} from './StockRowCells';
import { useListScroll, type ListScrollAnchor } from './useListScroll';
import { ChartIcon, GearIcon, PulseIcon } from './icons';
import { averageScore, groupRows, scoreColor, toggleGroup, type ListView } from './stockList';
import { fmtBig, fmtPercentPoints, fmtPrice, relativeTime, upsideColor } from '../format';
import Term from './Term';

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
  onOpenFeed: () => void;
  /** Symbol → stages the queue currently has in flight for it. */
  activity?: Record<string, string[]>;
  /** Shared with the rail, so collapsing the columns doesn't move the list. */
  scrollAnchor: MutableRefObject<ListScrollAnchor>;
}

/**
 * Which columns a viewport has room for, narrowest first.
 *
 * Name and score are the list; everything else is detail about a stock you can
 * open. So the table gives columns up from the right end of that ranking rather
 * than scrolling sideways — a list that hides its own score behind a scrollbar
 * has stopped being a ranking. Each header and its cells share one entry, or
 * a column could fold away while its label stayed.
 */
const COL = {
  verdict: 'hidden sm:table-cell',
  price:   'hidden sm:table-cell',
  target:  'hidden md:table-cell',
  trend:   'hidden lg:table-cell',
  model:   'hidden lg:table-cell',
  mcap:    'hidden lg:table-cell',
  age:     'hidden xl:table-cell',
} as const;

/**
 * Below `xl` the name column takes what the others leave and truncates in it.
 * Left to the table, a cell is never narrower than its longest unbroken line —
 * and `truncate` makes the whole company name one line, so a long name pushed
 * the score off the right edge instead of shortening. From `xl` on every column
 * fits beside the full name, and the table spreads them as it always has.
 */
const NAME_CELL = 'w-full max-w-0 xl:w-auto xl:max-w-none';

/**
 * A group heading's cells. Sticky under the column labels (`top-8` is
 * `HEADER_HEIGHT`), so a long group still says what it is while you are in
 * the middle of it. The cells carry the background, not the row: a sticky
 * row is not a thing tables do.
 */
const GROUP_CELL = 'sticky top-8 z-[5] border-b border-ink-700 bg-ink-900 py-0 transition group-hover:bg-ink-800';

/** Every column after name and score — what the heading's last cell spans. */
const TRAILING_COLUMNS = 7;

/**
 * The stock list at full width: every column the overview has room for.
 *
 * Its narrow twin is `StockRail`, and the two columns they share come from
 * `StockRowCells` so they are the same markup at the same height. The rest of
 * the row is free to stack — a fair value over its distance from the price is
 * one fact, and reads better as one cell than as two columns.
 */
export default function StockTable({
  rows, total, loading, view, onViewChange, onSelect, onOpenAdmin, onOpenEvaluation, onOpenFeed,
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
  const groups = groupRows(rows, view.group);

  // One stock's row — the same under a group heading as in the plain list.
  const renderRow = (r: OverviewRow) => (
    <tr
      key={r.symbol}
      data-stock-row
      data-symbol={r.symbol}
      onClick={() => onSelect(r.symbol)}
      title={rowTitle(r, fmtBig)}
      className={`${ROW_HEIGHT} cursor-pointer border-b border-ink-800 transition hover:bg-ink-800`}
    >
      <td className={`${NAME_CELL} py-1 pr-2 pl-3`}>
        <StockIdentity row={r} active={false} stages={activity[r.symbol]} />
      </td>

      <td className="px-2 py-1 text-right">
        <StockScore row={r} split />
      </td>

      <td className={`${COL.trend} px-2 py-1`}>
        <ScoreSparkline points={r.scoreHistory} />
      </td>

      <td className={`${COL.verdict} whitespace-nowrap px-2 py-1`}>
        {r.recommendation ? (
          <RecommendationBadge
            rec={r.recommendation}
            score={r.score}
            heldBack={r.verdictCapped ? r.capReasons : []}
            size="sm"
          />
        ) : (
          <span className="text-[11px] text-ink-600">nicht analysiert</span>
        )}
        {r.verdictModel && (
          <div className="font-mono text-[9px] leading-3 text-ink-600">{r.verdictModel}</div>
        )}
      </td>

      <td className={`${COL.price} whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular text-ink-200`}>
        {fmtPrice(r.price, r.currency)}
      </td>

      <td className={`${COL.target} whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular`}>
        <div className="text-ink-300">{r.targetMean === null ? '—' : fmtPrice(r.targetMean, r.currency)}</div>
        <div className={`text-[10px] ${upsideColor(r.targetUpsidePct)}`}>{fmtPercentPoints(r.targetUpsidePct)}</div>
      </td>

      <td className={`${COL.model} whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular`}>
        <div className="text-ink-300">
          {r.compositeFairValue === null ? '—' : fmtPrice(r.compositeFairValue, r.currency)}
        </div>
        <div className={`text-[10px] ${upsideColor(r.compositeUpsidePct)}`}>{fmtPercentPoints(r.compositeUpsidePct)}</div>
      </td>

      <td className={`${COL.mcap} whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular text-ink-400`}>
        {fmtBig(r.marketCap, r.currency)}
      </td>

      <td className={`${COL.age} whitespace-nowrap px-3 py-1 text-right text-[10px] text-ink-500`}>
        <Tip className="block leading-4" content="Alter der Marktdaten">
          {r.dataAgeHours === null
            ? '—'
            : r.dataAgeHours < 48
              ? `${r.dataAgeHours.toFixed(0)}h`
              : `${(r.dataAgeHours / 24).toFixed(0)}d`}
        </Tip>
        <Tip className="block leading-4 text-ink-600" content="Letztes AI-Verdict">
          {r.verdictAt ? relativeTime(r.verdictAt) : '—'}
        </Tip>
      </td>
    </tr>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-700 bg-ink-900 px-4 py-2">
        <h2 className="text-sm font-semibold text-ink-100">
          Übersicht{' '}
          <span className="text-ink-500">
            ({rows.length}{filtered ? ` von ${total}` : ''})
          </span>
        </h2>
        {avg && (
          <span className="text-[11px] text-ink-500">
            Ø Score <span className={scoreColor(avg.avg)}>{avg.avg.toFixed(1)}</span>
            {/* The count is the first thing a phone's header line can spare. */}
            <span className="hidden sm:inline"> über {avg.count} bewertete</span>
          </span>
        )}
        {/* On a phone the controls take a row of their own under the title,
            and the two icons stay up beside it rather than wrapping alone. */}
        <div className="order-last w-full sm:order-none sm:ml-auto sm:w-auto">
          <StockListControls view={view} onChange={onViewChange} layout="bar" />
        </div>
        <div className="ml-auto flex items-center gap-3 sm:ml-0">
          <button
            onClick={onOpenFeed}
            title="Was ist passiert — Herabstufungen, Insider, Kurssprünge und Quartalszahlen der Watchlist"
            className="rounded p-1 text-ink-400 transition hover:bg-ink-800 hover:text-ink-200"
          >
            <PulseIcon />
          </button>
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
                <th className="px-2 py-2 text-right font-semibold"><Term k="list.score">Score</Term></th>
                <th className={`${COL.trend} px-2 py-2 text-left font-semibold`}><Term k="list.trend">Verlauf</Term></th>
                <th className={`${COL.verdict} px-2 py-2 text-left font-semibold`}><Term k="list.verdict">Verdict</Term></th>
                <th className={`${COL.price} px-2 py-2 text-right font-semibold`}><Term k="list.price">Kurs</Term></th>
                <th className={`${COL.target} px-2 py-2 text-right font-semibold`}><Term k="list.target">Ø Ziel</Term></th>
                <th className={`${COL.model} px-2 py-2 text-right font-semibold`}><Term k="list.modelFv">Modell-FV</Term></th>
                <th className={`${COL.mcap} px-2 py-2 text-right font-semibold`}><Term k="list.mcap">MCap</Term></th>
                <th className={`${COL.age} px-3 py-2 text-right font-semibold`}><Term k="list.age">Aktualität</Term></th>
              </tr>
            </thead>
            <tbody>
              {groups
                ? groups.map((g) => {
                    const shut = view.collapsed.includes(g.key);
                    return (
                      <Fragment key={g.key}>
                        <tr
                          data-group-row
                          onClick={() => onViewChange(toggleGroup(view, g.key))}
                          className={`${GROUP_HEIGHT} group cursor-pointer`}
                        >
                          <td className={`${GROUP_CELL} pl-3 pr-2`}>
                            <button type="button" aria-expanded={!shut} className="flex w-full min-w-0 focus:outline-none">
                              <GroupName group={g} by={view.group} collapsed={shut} />
                            </button>
                          </td>
                          <td className={`${GROUP_CELL} px-2 text-right`}>
                            <GroupAverage group={g} />
                          </td>
                          <td colSpan={TRAILING_COLUMNS} className={GROUP_CELL} />
                        </tr>
                        {!shut && g.rows.map(renderRow)}
                      </Fragment>
                    );
                  })
                : rows.map(renderRow)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
