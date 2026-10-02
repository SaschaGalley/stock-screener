/**
 * One glyph for "passes / neither / fails / no data", shared by every
 * checklist on the page so a ✓ means the same thing in each.
 */
export type CheckMarkKind = 'pass' | 'mixed' | 'fail' | 'none';

export const CHECK_MARK: Record<CheckMarkKind, { glyph: string; cls: string }> = {
  pass:  { glyph: '✓', cls: 'text-emerald-400' },
  mixed: { glyph: '○', cls: 'text-amber-400' },
  fail:  { glyph: '✗', cls: 'text-red-400' },
  none:  { glyph: '–', cls: 'text-ink-600' },
};

export default function CheckMark({ kind, title }: { kind: CheckMarkKind; title?: string }) {
  const m = CHECK_MARK[kind];
  return <span className={`w-3 shrink-0 text-center font-mono ${m.cls}`} title={title}>{m.glyph}</span>;
}
