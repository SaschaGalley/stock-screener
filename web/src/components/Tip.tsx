import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** What the hover explains. A string keeps its line breaks. */
  content:   ReactNode;
  children:  ReactNode;
  className?: string;
  /**
   * Off where the anchor already sits inside something clickable — a rail row
   * is a button, and a tab stop inside a button is a second control in one.
   */
  focusable?: boolean;
}

/** Space kept between the tooltip and the thing it explains, and the window edge. */
const GAP = 6;
const EDGE = 8;

/**
 * An explanation that appears the moment the pointer arrives.
 *
 * The browser's `title` waits about a second before it shows anything, and on
 * the very hovers that exist to explain something — why a 7.8 reads HOLD, what
 * Z and T are — that second reads as "there is nothing here". This one opens
 * on hover or focus, at once.
 *
 * It renders into `body` with fixed coordinates, so a scroll box or a table
 * cell cannot clip it; and it closes on any scroll rather than drifting away
 * from its anchor. While it is open, the native titles of everything around it
 * are lifted: a row's own `title` would otherwise turn up a second later on
 * top of this one.
 */
export default function Tip({ content, children, className = '', focusable = true }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  // Above the anchor where it fits, below it where it doesn't; never past the
  // window's sides. Before paint, so it never flashes at the wrong place.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const a = anchorRef.current?.getBoundingClientRect();
    const t = tipRef.current?.getBoundingClientRect();
    if (!a || !t) return;
    const above = a.top - t.height - GAP;
    const top = above >= EDGE ? above : a.bottom + GAP;
    const left = Math.min(
      Math.max(EDGE, a.left + a.width / 2 - t.width / 2),
      window.innerWidth - t.width - EDGE,
    );
    setPos({ top, left });
  }, [open, content]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);

    const lifted: [Element, string][] = [];
    for (let el = anchorRef.current?.parentElement; el; el = el.parentElement) {
      const title = el.getAttribute('title');
      if (title === null) continue;
      lifted.push([el, title]);
      el.removeAttribute('title');
    }

    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
      // Only where nothing has written a new one in the meantime.
      for (const [el, title] of lifted) if (!el.hasAttribute('title')) el.setAttribute('title', title);
    };
  }, [open]);

  if (content === null || content === undefined || content === '') {
    return <span className={className}>{children}</span>;
  }

  return (
    <>
      <span
        ref={anchorRef}
        tabIndex={focusable ? 0 : undefined}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`cursor-help focus:outline-none ${className}`}
      >
        {children}
      </span>
      {open && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="pointer-events-none fixed z-50 max-w-sm whitespace-pre-line rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-left font-sans text-[11px] font-normal normal-case leading-snug tracking-normal text-ink-200 shadow-lg shadow-black/40"
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
