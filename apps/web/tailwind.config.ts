import type { Config } from 'tailwindcss';

/**
 * Stackd design system.
 *
 * Locked to the crumbs-dapp reference: warm off-white canvas, deep navy
 * sidebar, indigo for action, green reserved exclusively for gains. Fraunces
 * appears in the logo and the landing hero and nowhere else — everything that
 * is UI chrome is Inter.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#F7F5F0',
        surface: '#FFFFFF',
        // Slightly warmer than the canvas, for wells and table headers.
        sunken: '#F1EEE7',

        sidebar: {
          DEFAULT: '#1A1A2E',
          hover: '#24243E',
          active: '#2E2E4D',
          text: '#A5A3B8',
          heading: '#6C6A85',
        },

        primary: {
          DEFAULT: '#4F46E5',
          hover: '#4338CA',
          soft: '#EEEDFB',
          border: '#C7C3F4',
        },

        // Green is for gains only. Never use it for "success", buttons, or
        // decoration — a green pill in this UI always means the number went up.
        gain: {
          DEFAULT: '#16A34A',
          soft: '#E8F5EC',
        },
        loss: {
          DEFAULT: '#DC2626',
          soft: '#FBEAEA',
        },

        ink: {
          DEFAULT: '#1A1A2E',
          muted: '#6B6878',
          subtle: '#9A97A6',
        },

        line: {
          DEFAULT: '#E6E2D9',
          strong: '#D6D1C5',
        },
      },

      fontFamily: {
        // Inter — all UI.
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Fraunces — logo and hero only.
        display: ['var(--font-fraunces)', 'ui-serif', 'Georgia', 'serif'],
      },

      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },

      letterSpacing: {
        label: '0.08em',
      },

      borderRadius: {
        card: '14px',
      },

      boxShadow: {
        card: '0 1px 2px rgba(26, 26, 46, 0.04), 0 1px 12px rgba(26, 26, 46, 0.03)',
        lift: '0 4px 16px rgba(26, 26, 46, 0.08)',
        modal: '0 24px 64px rgba(26, 26, 46, 0.22)',
      },

      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        // Scan line that sweeps the receipt while Claude reads it.
        scan: {
          '0%': { transform: 'translateY(0%)', opacity: '0' },
          '10%': { opacity: '1' },
          '90%': { opacity: '1' },
          '100%': { transform: 'translateY(100%)', opacity: '0' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
        shimmer: 'shimmer 1.6s infinite',
        scan: 'scan 2.1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
