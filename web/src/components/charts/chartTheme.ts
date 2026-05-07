// Chart palette read from CSS vars at runtime so themes stay in sync.
// Falls back to baked-in values if the vars haven't loaded yet.

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  // var values are RGB triplets like "212 137 76"
  return `rgb(${v.replace(/\s+/g, ',')})`;
}

export const CHART_COLORS = {
  green:  readVar('--color-success', '#34c586'),
  red:    readVar('--color-danger',  '#e85b54'),
  blue:   readVar('--chart-blue',    '#599cc8'),
  amber:  readVar('--color-warning', '#e8a838'),
  purple: readVar('--chart-purple',  '#a871ae'),
  copper: readVar('--color-accent',  '#d4894c'),
  ink:    readVar('--color-text-faint', '#75695a'),
  bg:     readVar('--color-bg-base', '#16130e'),
  text:   readVar('--color-text',    '#ece4d9'),
  grid:   readVar('--color-border-soft', '#29231c'),
};

export const baseTextStyle = {
  color: CHART_COLORS.text,
  fontFamily: 'var(--font-mono), "SF Mono", Menlo, monospace',
};
