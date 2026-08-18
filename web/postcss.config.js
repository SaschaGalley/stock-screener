// Tailwind v4 ships its own PostCSS plugin and handles vendor prefixing
// internally via Lightning CSS, so autoprefixer is no longer in the chain.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
