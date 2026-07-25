import type { Config } from 'tailwindcss';

/**
 * Tokens, not a theme.
 *
 * The palette is taken from glazed Samarkand tilework — deep teal, the marigold used in its
 * borders — rather than the warm cream and terracotta that has become the default for anything
 * "artisanal". The paper is cool, not warm, so the teal stays a colour rather than turning muddy
 * against it, and `slate`/`chalk` exist for one purpose: the price board.
 */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#12303A',
        tile: { DEFAULT: '#1B6E77', deep: '#12525A', light: '#3E939B' },
        saffron: { DEFAULT: '#E3A02F', deep: '#C1811C' },
        pomegranate: '#9C2A24',
        paper: { DEFAULT: '#F6F5F1', sunk: '#EDEBE4' },
        slate: { board: '#23262A', edge: '#15171A' },
        chalk: { DEFAULT: '#EDE8DA', dim: '#A9A497' },
      },
      fontFamily: {
        display: ['Unbounded', 'system-ui', 'sans-serif'],
        body: ['Onest', 'system-ui', 'sans-serif'],
      },
      borderRadius: { stall: '0.375rem' },
      boxShadow: {
        board: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(18,48,58,0.18)',
        lift: '0 1px 2px rgba(18,48,58,0.06), 0 8px 24px -12px rgba(18,48,58,0.28)',
      },
    },
  },
  plugins: [],
} satisfies Config;
