/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── themeable tokens (CSS vars; switch in light/.dark) ──
        canvas: 'var(--bg)',
        elevated: 'var(--surface)',
        muted: 'var(--surface-2)',
        overlay: 'rgba(2, 6, 23, 0.55)',

        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        inverse: '#FFFFFF',

        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',

        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          glow: 'var(--accent-glow)',
        },

        // department accents — professional muted multi-hue (not pastel rainbow)
        dept: {
          sales: '#4F46E5', // indigo
          marketing: '#7C3AED', // violet
          accounting: '#0EA5E9', // sky
          analytics: '#0D9488', // teal
          general: '#475569', // slate
          assistant: '#4F46E5',
        },

        success: '#16A34A',
        warning: '#D97706',
        danger: '#DC2626',
        info: '#0284C7',

        // legacy "glass" tint keys kept so existing classes don't break,
        // now mapped to flat surface vars.
        glass: {
          'tint-thin': 'var(--surface-2)',
          'tint-regular': 'var(--surface)',
          'tint-thick': 'var(--surface)',
          'tint-chrome': 'var(--surface)',
          'border-soft': 'var(--border)',
          'border-bright': 'var(--border-strong)',
          highlight: 'rgba(255,255,255,0.04)',
        },
        // legacy rainbow keys → neutral (kept to avoid breakage)
        rainbow: {
          coral: 'var(--surface)',
          peach: 'var(--surface-2)',
          gold: 'var(--surface-2)',
          mint: 'var(--surface-2)',
          sky: 'var(--surface-2)',
          'fresh-blue': 'var(--accent-soft)',
          rose: 'var(--surface-2)',
        },
      },

      backgroundImage: {
        // subtle, professional accent gradient (no rainbow)
        'rainbow-prism': 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
        'rainbow-prism-soft':
          'linear-gradient(135deg, var(--accent-soft) 0%, var(--surface-2) 100%)',
      },

      backdropBlur: { thin: '6px', regular: '10px', thick: '14px', chrome: '18px' },

      boxShadow: {
        'elev-0': 'none',
        'elev-1': 'var(--shadow-1)',
        'elev-2': 'var(--shadow-2)',
        'elev-3': 'var(--shadow-3)',
        'elev-4': 'var(--shadow-4)',
        'glass-inset': 'none',
        'glow-primary': '0 0 0 3px var(--accent-glow)',
        'glow-rainbow': 'var(--shadow-2)',
        'glow-sales': '0 0 0 3px rgba(79,70,229,0.18)',
        'glow-marketing': '0 0 0 3px rgba(124,58,237,0.18)',
        'glow-accounting': '0 0 0 3px rgba(14,165,233,0.18)',
        'glow-analytics': '0 0 0 3px rgba(13,148,136,0.18)',
        'glow-general': '0 0 0 3px rgba(71,85,105,0.18)',
        'glow-assistant': '0 0 0 3px rgba(79,70,229,0.18)',
      },

      borderRadius: { xs: '6px', sm: '8px', md: '10px', lg: '14px', xl: '18px', '2xl': '22px' },

      fontFamily: {
        sans: ["'Inter'", "'Noto Sans JP'", 'system-ui', 'sans-serif'],
        display: ["'Inter'", "'Noto Sans JP'", 'system-ui', 'sans-serif'],
        mono: ["'JetBrains Mono'", 'ui-monospace', 'monospace'],
      },

      fontSize: {
        micro: ['10px', { lineHeight: '1.3' }],
        xs: ['11px', { lineHeight: '1.4' }],
        sm: ['13px', { lineHeight: '1.5' }],
        body: ['14px', { lineHeight: '1.6' }],
        h3: ['18px', { lineHeight: '1.4' }],
        h2: ['22px', { lineHeight: '1.3' }],
        h1: ['28px', { lineHeight: '1.2' }],
        display: ['40px', { lineHeight: '1.1' }],
      },

      transitionDuration: { fast: '120ms', base: '200ms', slow: '320ms', dramatic: '600ms' },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
        emphasized: 'cubic-bezier(0.2, 0, 0, 1.2)',
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },

      keyframes: {
        'aurora-drift-1': { '0%, 100%': { transform: 'translate(0,0)' }, '50%': { transform: 'translate(30px,-20px)' } },
        'aurora-drift-2': { '0%, 100%': { transform: 'translate(0,0)' }, '50%': { transform: 'translate(-25px,20px)' } },
        'aurora-drift-3': { '0%, 100%': { transform: 'translate(0,0)' }, '50%': { transform: 'translate(20px,25px)' } },
        'glass-shimmer': { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-5px)' } },
        'pulse-glow': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.6' } },
      },
      animation: {
        'aurora-1': 'aurora-drift-1 30s ease-in-out infinite',
        'aurora-2': 'aurora-drift-2 34s ease-in-out infinite',
        'aurora-3': 'aurora-drift-3 28s ease-in-out infinite',
        shimmer: 'glass-shimmer 3s linear infinite',
        float: 'float 4s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
