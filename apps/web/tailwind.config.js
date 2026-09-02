/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── テーマ変数（src/index.css の :root / .dark で切り替わる） ──
        canvas: 'var(--bg)',
        elevated: 'var(--surface)',
        // 面の色。`muted` という名前だと text-muted ユーティリティを乗っ取り、
        // 111箇所の副次テキストが白地に白で描かれていた（v1 からの既存バグ）。
        sunken: 'var(--surface-2)',
        hairline: 'var(--hairline)',
        overlay: 'rgba(16, 21, 33, 0.42)',

        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        // `muted` は文字の色。面は `sunken`。
        // 逆にすると text-muted が面の色（ほぼ白）を指し、白地に白の文字になる。
        muted: 'var(--text-muted)',
        'text-muted': 'var(--text-muted)',
        'ink-decorative': 'var(--ink-decorative)', // 文字には使わない。罫線と装飾アイコン専用
        inverse: 'var(--text-inverse)',

        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',

        // 主アクション。アクセント案(A/B/C)の切り替えは index.css の --action 2行だけ
        action: {
          DEFAULT: 'var(--action)',
          hover: 'var(--action-hover)',
        },

        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          'soft-border': 'var(--accent-soft-border)',
          'on-dark': 'var(--accent-on-dark)',
          glow: 'var(--accent-glow)',
        },

        // 部署＝データの色。アクセントとは役割が違うので直値で持つ
        dept: {
          sales: 'var(--dept-sales)',
          marketing: 'var(--dept-marketing)',
          accounting: 'var(--dept-accounting)',
          analytics: 'var(--dept-analytics)',
          general: 'var(--dept-general)',
          assistant: 'var(--dept-assistant)',
        },

        success: '#16A34A',
        warning: '#D97706',
        danger: '#DC2626',
        info: '#0284C7',
      },

      // タブ・ボトムナビ専用。カードや表には使わない（index.css のコメント参照）
      backdropBlur: { tab: '14px' },

      boxShadow: {
        'elev-0': 'none',
        'elev-1': 'var(--shadow-1)',
        'elev-2': 'var(--shadow-2)',
        'elev-3': 'var(--shadow-3)',
        'elev-4': 'var(--shadow-4)',
        'glow-primary': '0 0 0 3px var(--accent-glow)',
      },

      /* 角丸は 7（部品）/ 9（カード）/ 12（パネル）の3段だけ。
       * 既存クラス名は全部残したまま、6キーを3つの値に畳んでいる。
       * こうするとコンポーネントを1行も触らずに階段が3段に揃う。 */
      borderRadius: {
        xs: '7px',
        sm: '7px',
        md: '9px',
        lg: '9px',
        xl: '12px',
        '2xl': '12px',
        control: '7px',
        card: '9px',
        panel: '12px',
      },

      fontFamily: {
        sans: ["'Manrope'", "'Noto Sans JP'", 'system-ui', 'sans-serif'],
        display: ["'Manrope'", "'Noto Sans JP'", 'system-ui', 'sans-serif'],
        mono: ["'IBM Plex Mono'", 'ui-monospace', 'monospace'],
      },

      fontSize: {
        micro: ['10px', { lineHeight: '1.3' }],
        xs: ['11px', { lineHeight: '1.4' }],
        sm: ['13px', { lineHeight: '1.5' }],
        body: ['14px', { lineHeight: '1.6' }],
        h3: ['18px', { lineHeight: '1.4' }],
        h2: ['22px', { lineHeight: '1.3' }],
        h1: ['28px', { lineHeight: '1.2' }],
        display: ['34px', { lineHeight: '1.15' }],
      },

      /* モーションの値は components/motion/springs.ts が正本。
       * ここは CSS トランジション用の最小限だけ持つ。 */
      transitionDuration: { fast: '140ms', base: '220ms', slow: '380ms' },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
        emphasized: 'cubic-bezier(0.2, 0, 0, 1.2)',
      },
    },
  },
  plugins: [],
};
