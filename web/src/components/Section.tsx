import { createContext, useContext, useState, useEffect, useLayoutEffect, useRef, ReactNode } from 'react';
import type { GlossaryKey } from '../glossary';
import Term from './Term';

interface Props {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  rightHeader?: ReactNode;
  /** Stable key used to persist open state in localStorage. Defaults to title. */
  storageKey?: string;
  /** What the section is for, behind an ⓘ beside its title. */
  info?: GlossaryKey;
  /**
   * What the section finds, in a line — "Fairer Wert 328 $, 2 % unter dem
   * Kurs" rather than "DCF, peer multiples, reverse DCF". Takes the place of
   * the subtitle, which says what the section holds; a body that loads its
   * own data can say it instead through `useSectionFinding`.
   */
  finding?: string | null;
  /**
   * Always open, no toggle. Inside a stock page's tab everything is shown: a
   * remembered fold meant two clicks to look and then a section that stayed
   * open for good, so the tab does the choosing instead.
   */
  fixed?: boolean;
}

const STORAGE_PREFIX = 'stockcli:section:';

const FindingContext = createContext<((finding: string | null) => void) | null>(null);

/**
 * Report the section's finding from inside its body, once the body has the
 * data — the analysts' record, the five-year history and the chart load
 * their own. Null while loading leaves the subtitle in place.
 */
export function useSectionFinding(finding: string | null): void {
  const set = useContext(FindingContext);
  useEffect(() => {
    set?.(finding);
    return () => set?.(null);
  }, [set, finding]);
}

function readStoredOpen(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === '0') return false;
    if (raw === '1') return true;
    return fallback;
  } catch { return fallback; }
}

function writeStoredOpen(key: string, open: boolean): void {
  try { localStorage.setItem(STORAGE_PREFIX + key, open ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * An open/closed state that survives a reload — the Section's own, and any
 * disclosure inside one that should be remembered the same way.
 */
export function useStoredOpen(key: string, defaultOpen: boolean): [boolean, (f: (open: boolean) => boolean) => void] {
  const [open, setOpen] = useState(() => readStoredOpen(key, defaultOpen));
  useEffect(() => { writeStoredOpen(key, open); }, [key, open]);
  return [open, setOpen];
}

// ── Building a long page a section at a time ────────────────────────────────
//
// The stock page is twenty sections and ten charts. Built in one go it held
// the main thread for a quarter of a second on opening, and everything below
// the fold was built before anything could be scrolled. A section now builds
// its body when it comes near the visible part of its scroll container, and
// the rest are built one per idle moment, top to bottom — the same work, cut
// into pieces the browser can paint between.

type Idle = (cb: () => void, opts?: { timeout: number }) => number;
const requestIdle: Idle = typeof window !== 'undefined' && 'requestIdleCallback' in window
  ? (cb, opts) => (window as unknown as { requestIdleCallback: Idle }).requestIdleCallback(cb, opts)
  : (cb) => window.setTimeout(cb, 30);

const waiting: (() => void)[] = [];
let pumping = false;

function pump(): void {
  pumping = false;
  waiting.shift()?.();
  if (waiting.length) schedule();
}

function schedule(): void {
  if (pumping) return;
  pumping = true;
  requestIdle(pump, { timeout: 500 });
}

/** Run `build` in an idle moment of its own, after those queued before it; the returned function withdraws it. */
function whenIdle(build: () => void): () => void {
  waiting.push(build);
  schedule();
  return () => {
    const i = waiting.indexOf(build);
    if (i >= 0) waiting.splice(i, 1);
  };
}

/** The nearest ancestor that scrolls — the root a section's nearness is measured against. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/** How tall each section's body was when last built, so its placeholder holds about the same room. */
const lastHeight = new Map<string, number>();
const PLACEHOLDER_HEIGHT = 240;

/** True once the body should exist: near the visible part of the page, or its turn in the idle queue. */
function useBuilt(ref: React.RefObject<HTMLElement | null>, wanted: boolean): boolean {
  const [built, setBuilt] = useState(false);
  useEffect(() => {
    if (built || !wanted) return;
    const el = ref.current;
    if (!el) return;
    let done = false;
    const build = () => { if (!done) { done = true; setBuilt(true); } };
    const near = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) build(); }, {
      root: scrollParent(el), rootMargin: '600px 0px',
    });
    near.observe(el);
    const withdraw = whenIdle(build);
    return () => { done = true; near.disconnect(); withdraw(); };
  }, [built, wanted, ref]);
  return built;
}

export default function Section({ title, subtitle, defaultOpen = true, children, rightHeader, storageKey, info, fixed = false, finding = null }: Props) {
  const key = storageKey ?? title;
  const [reported, setReported] = useState<string | null>(null);
  const found = reported ?? finding;
  const [stored, setOpen] = useStoredOpen(key, defaultOpen);
  const open = fixed || stored;
  const ref = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const built = useBuilt(ref, open);
  // Measured once, when the body goes — the next stock's placeholder for this section.
  useLayoutEffect(() => {
    const el = body.current;
    if (!built || !el) return;
    return () => { if (el.offsetHeight) lastHeight.set(key, el.offsetHeight); };
  }, [built, key]);

  return (
    <section ref={ref} className="overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
      {fixed ? (
        <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-ink-700 bg-ink-900 px-4 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 className="text-sm font-semibold text-ink-100">
              {info ? <Term k={info}>{title}</Term> : title}
            </h2>
            {found
              ? <span className="text-xs text-ink-300">{found}</span>
              : subtitle && <span className="text-xs text-ink-500">{subtitle}</span>}
          </div>
          {rightHeader && <div className="flex items-center gap-2">{rightHeader}</div>}
        </div>
      ) : (
        <button
          onClick={() => setOpen((x) => !x)}
          className="flex w-full items-center justify-between gap-3 border-b border-ink-700 bg-ink-900 px-4 py-2.5 text-left transition hover:bg-ink-800"
          aria-expanded={open}
        >
          <div className="flex items-baseline gap-3">
            <span className={`text-ink-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
            <h2 className="text-sm font-semibold text-ink-100">
              {info ? <Term k={info} focusable={false}>{title}</Term> : title}
            </h2>
            {found
              ? <span className="text-xs text-ink-300">{found}</span>
              : subtitle && <span className="text-xs text-ink-500">{subtitle}</span>}
          </div>
          {rightHeader && <div className="flex items-center gap-2">{rightHeader}</div>}
        </button>
      )}
      {open && (built
        ? <FindingContext.Provider value={setReported}><div ref={body} className="overflow-x-auto p-3 sm:p-4">{children}</div></FindingContext.Provider>
        : <div aria-busy="true" style={{ height: lastHeight.get(key) ?? PLACEHOLDER_HEIGHT }} />)}
    </section>
  );
}
