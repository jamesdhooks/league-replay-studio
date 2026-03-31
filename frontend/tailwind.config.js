/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ── Background tiers ──
        bg: {
          primary: '#0f0f14',      // App background (deepest)
          secondary: '#16161e',    // Panels, cards
          tertiary: '#1c1c28',     // Elevated surfaces
          hover: '#22222e',        // Hover states
        },
        // ── Surface / interactive ──
        surface: {
          DEFAULT: '#1c1c28',
          hover: '#262636',
          active: '#2e2e42',
          border: '#2a2a3a',
        },
        // ── Border tiers ──
        border: {
          DEFAULT: '#2a2a3a',
          subtle: '#1f1f2e',
          strong: '#3a3a4e',
          focus: '#5b8af5',
        },
        // ── Text tiers ──
        text: {
          primary: '#e8e8f0',
          secondary: '#a0a0b8',
          tertiary: '#6e6e88',
          disabled: '#4a4a5e',
        },
        // ── Accent / brand ──
        accent: {
          DEFAULT: '#5b8af5',
          hover: '#7ba3ff',
          muted: '#3d5fa0',
          text: '#a3c4ff',
        },
        // ── Status colors ──
        success: {
          DEFAULT: '#4ade80',
          muted: '#1a3a2a',
          text: '#86efac',
        },
        warning: {
          DEFAULT: '#fbbf24',
          muted: '#3a2e1a',
          text: '#fcd34d',
        },
        danger: {
          DEFAULT: '#f87171',
          muted: '#3a1a1a',
          text: '#fca5a5',
        },
        info: {
          DEFAULT: '#60a5fa',
          muted: '#1a2a3a',
          text: '#93c5fd',
        },
        // ── Event type colors (for timeline) ──
        event: {
          incident: '#ef4444',
          battle: '#f97316',
          overtake: '#3b82f6',
          pit: '#8b5cf6',
          fastest: '#22c55e',
          leader: '#eab308',
          firstlap: '#06b6d4',
          lastlap: '#ec4899',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        'xxs': ['0.625rem', { lineHeight: '0.875rem' }],  // 10px
      },
      spacing: {
        'toolbar': '3rem',     // 48px toolbar height
        'statusbar': '1.75rem', // 28px status bar height
        'sidebar': '16rem',    // 256px default sidebar width
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'slide-down': 'slideDown 0.2s ease-out',
        'slide-right': 'slideRight 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideRight: {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
}
