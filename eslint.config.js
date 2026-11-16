// ルートの ESLint 設定（flat config）。対象は TypeScript のパッケージだけ:
//   apps/web, apps/api-gateway, packages/shared-types, packages/db-schema
// apps/ai-engine (Python)・n8n-workflows・design-canvas・marketing・docs などは対象外。
//
// 型情報を使うルール (recommendedTypeChecked) は CI 時間との兼ね合いで未導入。
// 既存コードで多発するルールは warn に落としてある（件数は `npm run lint` の出力を参照）。

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');

module.exports = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/ai-engine/**',
      'apps/n8n-workflows/**',
      'apps/n8n-workflows.bak.*/**',
      'apps/web/demo/**',
      'apps/web/scripts/**',
      'design-canvas/**',
      'marketing/**',
      'docs/**',
      'scripts/**',
      'ontology/**',
      'tests/**',
      'usage-metrics-svc/**',
      'packages/db-schema/prisma/migrations/**',
      '**/*.{js,cjs,mjs}',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── 全パッケージ共通 ──
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      // 既存コードに多い。段階的に減らす対象
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
    },
  },

  // ── api-gateway / db-schema (Node) ──
  {
    files: ['apps/api-gateway/**/*.ts', 'packages/db-schema/**/*.ts', 'packages/shared-types/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── web (ブラウザ + React) ──
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler 系の新ルール。既存の「effect 内で setState」(データ取得後の反映・
      // 初期化など) を直すと描画タイミングが変わるので、挙動を変えない今回は warn に留める
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── テスト ──
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'apps/api-gateway/tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
);
