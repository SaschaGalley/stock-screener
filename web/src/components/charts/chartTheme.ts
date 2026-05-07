// Chart palette read from CSS vars at runtime so themes stay in sync.
// Falls back to baked-in hex values if the vars haven't loaded yet.

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export const CHART_COLORS = {
  green:  readVar('--color-success',     '#6cb892'),
  red:    readVar('--color-danger',      '#d77279'),
  blue:   readVar('--chart-blue',        '#7da4d4'),
  amber:  readVar('--color-warning',     '#d6a865'),
  purple: readVar('--chart-purple',      '#a386c1'),
  copper: readVar('--color-accent',      '#7da4d4'),
  ink:    readVar('--color-text-faint',  '#555c69'),
  bg:     readVar('--color-bg-base',     '#181c25'),
  text:   readVar('--color-text',        '#cad1da'),
  grid:   readVar('--color-border-soft', '#1f242e'),
};

export const baseTextStyle = {
  color: CHART_COLORS.text,
  fontFamily: 'var(--font-mono), "SF Mono", Menlo, monospace',
};
