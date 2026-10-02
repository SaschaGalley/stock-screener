import type { ReactNode } from 'react';
import { GLOSSARY, type GlossaryKey } from '../glossary';
import Tip from './Tip';

interface Props {
  /** The explanation, from the glossary. */
  k?: GlossaryKey;
  /** Or one given here — for a pillar, a dimension, or text the server wrote. */
  text?: ReactNode;
  /** What this instance adds: the live figures behind it, a caveat that applies today. */
  extra?: ReactNode;
  /** The label. Without it only the ⓘ shows, for a place where the label is something else. */
  children?: ReactNode;
  className?: string;
  /** Off inside something already clickable, as for `Tip`. */
  focusable?: boolean;
}

/**
 * A label with its explanation one hover away, and the ⓘ that says so.
 *
 * The mark is the point: a hover nobody knows is there explains nothing, and
 * the ⓘ beside the run-rate P/S was the only one anybody found. So every
 * explained label wears it, the whole label is the hover target, and the text
 * comes from the glossary, which says the same thing wherever the figure
 * appears.
 */
export default function Term({ k, text, extra, children, className = '', focusable }: Props) {
  const body = k ? GLOSSARY[k] : text;
  if (!body && !extra) return <>{children}</>;
  return (
    <Tip
      focusable={focusable}
      className={className}
      content={
        <>
          {body}
          {extra && <div className={body ? 'mt-1.5 border-t border-ink-700 pt-1.5 text-ink-300' : ''}>{extra}</div>}
        </>
      }
    >
      {children}
      <span aria-hidden className={`${children ? 'ml-1' : ''} font-sans text-[0.9em] font-normal normal-case tracking-normal text-ink-500`}>ⓘ</span>
    </Tip>
  );
}
