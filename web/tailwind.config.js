/** @type {import('tailwindcss').Config} */
// All theme tokens come from CSS vars defined in src/styles.css.
// Edit those vars (HEX values, click them in your editor for a color picker)
// to retheme the app — no rebuild needed for runtime changes.
//
// Tradeoff: with hex-format vars, Tailwind's `<alpha-value>` modifier
// (e.g. `bg-ink-900/50`) is not supported. Use the explicit `*-soft`
// variants for tinted backgrounds instead.
const v = (name) => `var(${name})`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['var(--font-sans)'],
        mono:    ['var(--font-mono)'],
        display: ['var(--font-display)'],
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
      },
      // Text that reads as text. `ink-600` is a border, and a border-strength
      // grey is unreadable as type (1.8:1), but it was used for both — so text
      // gets its own shade under the same name, and borders keep theirs.
      // Tailwind v4 resolves `text-*` through `--text-color-*` before
      // `--color-*`, which is what this key feeds.
      textColor: {
        ink: { 600: v('--color-text-ghost') },
      },
      // The small end of the type scale, named, so it is set here and not in
      // two hundred arbitrary pixel values. Below 11px nothing is readable at
      // a glance; `3xs` is for the one-word annotations under a figure.
      fontSize: {
        '3xs': ['10px', { lineHeight: '14px' }],
        '2xs': ['11px', { lineHeight: '16px' }],
      },
      colors: {
        // Background / text ramp via the `ink-50…ink-950` naming kept for
        // backwards compat. Semantic mapping:
        //   ink-950 = bg-deep   |  ink-900 = bg-base   |  ink-800 = bg-elevated
        //   ink-700 = border    |  ink-600 = border-strong (text: ghost, below)
        //   ink-500 = text-faint|  ink-400 = text-muted  |  ink-300 = text-secondary
        //   ink-200 = text      |  ink-100/50 = text-strong
        ink: {
          50:  v('--color-text-strong'),
          100: v('--color-text-strong'),
          200: v('--color-text'),
          300: v('--color-text-secondary'),
          400: v('--color-text-muted'),
          500: v('--color-text-faint'),
          600: v('--color-border-strong'),
          700: v('--color-border'),
          800: v('--color-bg-elevated'),
          900: v('--color-bg-base'),
          950: v('--color-bg-deep'),
        },
        accent: {
          DEFAULT: v('--color-accent'),
          dark:    v('--color-accent-hover'),
          soft:    v('--color-accent-soft'),
        },
        // Semantic colors — readable foregrounds + pre-tinted backgrounds.
        // Tailwind shade names are mapped:
        //   *-400/500/600 = readable foreground color
        //   *-700/800/900/950 = soft/tinted background variant
        emerald: {
          400: v('--color-success'),       500: v('--color-success'),       600: v('--color-success'),
          700: v('--color-success-soft'),  800: v('--color-success-soft'),
          900: v('--color-success-soft'),  950: v('--color-success-soft'),
        },
        red: {
          400: v('--color-danger'),        500: v('--color-danger'),        600: v('--color-danger'),
          700: v('--color-danger-soft'),   800: v('--color-danger-soft'),
          900: v('--color-danger-soft'),   950: v('--color-danger-soft'),
        },
        amber: {
          400: v('--color-warning'),       500: v('--color-warning'),       600: v('--color-warning'),
          700: v('--color-warning-soft'),  800: v('--color-warning-soft'),
          900: v('--color-warning-soft'),  950: v('--color-warning-soft'),
        },
      },
    },
  },
  plugins: [],
};
