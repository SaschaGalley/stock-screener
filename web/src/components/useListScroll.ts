import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react';

/**
 * Where the one list is scrolled, said in terms both densities can honour: the
 * topmost visible stock, and how far below the top edge of the box it sits.
 */
export interface ListScrollAnchor {
  symbol: string | null;
  /** Pixels from the scroll box's top edge to that row's top edge. */
  offset: number;
}

export const EMPTY_ANCHOR: ListScrollAnchor = { symbol: null, offset: 0 };

/**
 * Keep the one list where it was when the density changes.
 *
 * The table and the rail are separate elements, so the browser cannot carry a
 * scroll offset between them: collapsing the columns used to drop you at the
 * top of the list, or shove the stock you clicked to the bottom edge.
 *
 * The anchor is a row rather than a number of pixels. Pixels do not survive the
 * trip — the table's scroll box also contains a header row — whereas "GOOGL was
 * 40px below the top" means the same thing in both. Restoring is then one
 * measurement and one correction, with nothing assumed about row heights.
 *
 * The offset is measured from the box's own top edge, which both densities put
 * at the same height on screen — so a row restored to the same offset is a row
 * on the same pixel. `obstruction` is a separate question: it is what the
 * table's sticky column labels cover, and it decides only whether the selected
 * stock counts as *on show*. A row hidden behind those labels is not something
 * the reader can see, so arriving at the rail it gets scrolled into view
 * instead of being left where the arithmetic would put it.
 *
 * `visible` matters because the rail is hidden rather than unmounted (an
 * analysis run must survive the detour to the table). A `display: none` box
 * reports every measurement as zero, so it must neither record nor restore
 * while it is away.
 */
export function useListScroll(
  anchor: MutableRefObject<ListScrollAnchor>,
  visible: boolean,
  selectedSymbol: string | null,
  /** Rows currently rendered — the restore has to wait until there are some. */
  rowCount: number,
  /** Pixels of the box's top edge hidden behind something sticky. */
  obstruction: (el: HTMLElement) => number = () => 0,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);
  // A ref, so a fresh closure each render doesn't re-arm the effects below.
  const obstructionRef = useRef(obstruction);
  obstructionRef.current = obstruction;

  /** The top edge a reader actually sees, not the one the box claims. */
  const visibleTop = (el: HTMLElement) => el.getBoundingClientRect().top + obstructionRef.current(el);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el || !visible) return;
    const top = el.getBoundingClientRect().top;
    for (const row of el.querySelectorAll<HTMLElement>('[data-stock-row]')) {
      const r = row.getBoundingClientRect();
      // The first row still showing any of itself is the one to remember.
      if (r.bottom > top + 1) {
        anchor.current = { symbol: row.dataset.symbol ?? null, offset: r.top - top };
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, visible]);

  // Before paint, so the list is never shown at the wrong offset for a frame.
  useLayoutEffect(() => {
    if (!visible) { restored.current = false; return; }
    if (restored.current) return;
    const el = containerRef.current;
    if (!el || rowCount === 0) return;          // no rows yet — try again next render
    restored.current = true;

    const ref = anchor.current.symbol
      ? el.querySelector<HTMLElement>(`[data-stock-row][data-symbol="${cssEscape(anchor.current.symbol)}"]`)
      : null;
    if (ref) {
      el.scrollTop += (ref.getBoundingClientRect().top - el.getBoundingClientRect().top) - anchor.current.offset;
    }

    // A remembered row is the common case, but not the only one: a deep link,
    // or a stock picked out of a list that has since been filtered, can leave
    // the selection outside the box. Then the selection wins over the memory.
    nudgeSelectionIntoView(el, 'center', visibleTop(el));
    onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rowCount]);

  // Stepping through symbols with the analysis open should not leave the
  // current one off-screen — but nudge, never recentre.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !visible || !restored.current) return;
    if (nudgeSelectionIntoView(el, 'nearest', visibleTop(el))) onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol, visible, onScroll]);

  return { containerRef, onScroll };
}

/** Scrolls the selected row in if it is not fully on show. Returns whether it moved. */
function nudgeSelectionIntoView(el: HTMLElement, block: ScrollLogicalPosition, top: number): boolean {
  const sel = el.querySelector('[data-stock-row][data-selected="true"]');
  if (!sel) return false;
  const row = sel.getBoundingClientRect();
  if (row.top >= top && row.bottom <= el.getBoundingClientRect().bottom) return false;
  sel.scrollIntoView({ block });
  return true;
}

/** Tickers carry dots (AIR.PA) and dashes (BRK-B), which a selector reads as syntax. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
}
