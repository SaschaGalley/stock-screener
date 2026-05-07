/** @type {import('tailwindcss').Config} */
// All theme tokens come from CSS vars defined in src/styles.css.
// Edit those vars to retheme. RGB-triplet format enables `bg-ink-900/50`-style
// alpha modifiers via Tailwind's <alpha-value> placeholder.
function rgbVar(name) {
  return `rgb(var(${name}) / <alpha-value>)`;
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
        display: ['var(--font-display)'],
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
      },
      colors: {
        // ── Background / surface ramp ──
        // Naming kept as `ink-50…ink-950` for backwards compat; semantic mapping:
        //   ink-950 = bg-deep (window bg)
        //   ink-900 = bg-base (cards, sidebars)
        //   ink-800 = bg-elevated (popovers, hovers)
        //   ink-700 = border (default)
        //   ink-600 = border-strong
        //   ink-500 = text-faint (labels, hints)
        //   ink-400 = text-muted (secondary)
        //   ink-300 = text-muted-strong
        //   ink-200 = text
        //   ink-100 = text-strong (headings)
        //   ink-50  = text-strong (white-ish)
        ink: {
          50:  rgbVar('--color-text-strong'),
          100: rgbVar('--color-text-strong'),
          200: rgbVar('--color-text'),
          300: rgbVar('--color-text-muted'),
          400: rgbVar('--color-text-muted'),
          500: rgbVar('--color-text-faint'),
          600: rgbVar('--color-border-strong'),
          700: rgbVar('--color-border'),
          800: rgbVar('--color-bg-elevated'),
          900: rgbVar('--color-bg-base'),
          950: rgbVar('--color-bg-deep'),
        },
        accent: {
          DEFAULT: rgbVar('--color-accent'),
          dark:    rgbVar('--color-accent-hover'),
          soft:    rgbVar('--color-accent-soft'),
        },
        // Override Tailwind's emerald/red/amber for consistent semantic look.
        emerald: {
          400: rgbVar('--color-success'),
          500: rgbVar('--color-success'),
          600: rgbVar('--color-success'),
          700: rgbVar('--color-success-soft'),
          900: rgbVar('--color-success-soft'),
          950: rgbVar('--color-success-soft'),
        },
        red: {
          400: rgbVar('--color-danger'),
          500: rgbVar('--color-danger'),
          600: rgbVar('--color-danger'),
          700: rgbVar('--color-danger-soft'),
          900: rgbVar('--color-danger-soft'),
          950: rgbVar('--color-danger-soft'),
        },
        amber: {
          400: rgbVar('--color-warning'),
          500: rgbVar('--color-warning'),
          600: rgbVar('--color-warning'),
          700: rgbVar('--color-warning-soft'),
          900: rgbVar('--color-warning-soft'),
          950: rgbVar('--color-warning-soft'),
        },
        // Charts use raw values from --chart-*; access them in JS, not classes.
      },
    },
  },
  plugins: [],
};
