# FLOW Design System v2 — 白基調の法人SaaS × 塗らないリキッドガラス

> **目的**: `org-ai-platform` のデザインの単一の情報源。
> コードを書く前にこれを読み、ここにあるトークンとコンポーネントだけを使うこと。
> **値の正本はコード側**にある: 色・影・ガラスは `apps/web/src/index.css`、
> Tailwind キーは `apps/web/tailwind.config.js`、モーションは
> `apps/web/src/components/motion/springs.ts`。このドキュメントは構造と規範を説明する。

旧 v1（"Liquid Glass Prism" 虹グラデ）は 2026-08 に全面置換された。
`rainbow-*` / `aurora-*` / クリーム系の色は存在しない。見つけたら消してよい。

---

## 1. 原則

| 原則 | 意味 |
|---|---|
| **フラットな白** | カード・表・サイドバー・モーダル本体は不透明な白（`--surface`）。数字が載る面に半透明は使わない |
| **塗らないガラス** | ガラスに色を塗らない。面はほぼ透明（白5〜14%）で、色は `backdrop-filter` が**背景から拾う**。選択中も塗らず、背景を暗くする（smoke） |
| **ガラスは浮いているものだけ** | 許可: タブ・チップ・主ボタン・入力バー・ボトムナビ・トースト・TOPの入口。禁止: カード・表・サイドバー・モーダル本体 |
| **青は面積を取らない** | `--accent`（青）はリンク・フォーカス・選択インジケータのみ。主アクションはインク（`--action`、ダークでは白抜きに反転） |
| **数字は等幅** | 金額・件数・%が縦に並ぶ場所は `font-mono` か `.tabular` |

## 2. トークン（`src/index.css` が正本）

### 面と文字
`--bg` / `--surface` / `--surface-2` / `--hairline` / `--border` / `--border-strong`
`--text-primary` / `--text-secondary` / `--text-muted`（**文字色の下限**。これより薄い文字は禁止。キャンバス地で4.69:1）/ `--text-inverse` / `--ink-decorative`（文字に使わない。罫線・装飾アイコン専用）

Tailwind キー: `bg-canvas` `bg-elevated` `bg-sunken`、`text-primary` `text-secondary` `text-muted`、`border-border` `border-border-strong`。
※ `muted` は**文字**、面は `sunken`。逆にすると白地に白の文字になる（v1 の実バグ）。

### 意味の色・データの色
- ステータス: `success` / `warning` / `danger` / `info`（= `var(--success)` 等。ダークで一段明るくなる）
- 部署色: `constants/departments.ts` の `DEPT_ACCENT` / `DEPT_LABEL`（データの色。style での直接使用可）
- 外部ブランド色: `constants/brand.ts`（Twitter/Instagram/LinkedIn）
- **上記以外の hex 直書きは禁止**。`node apps/web/scripts/check-design-tokens.mjs` が検出する
  （除外: `src/taskmanager/**`＝凍結領域、constants の2ファイル、生成物）

### ガラス（3層）と smoke
- `--glass-fill`（ほぼ透明の面）+ `--glass-blur`（blur+saturate）+ `--glass-rim`（薄膜干渉の conic 枠）+ `--glass-spec`（上面の艶）+ `--glass-shadow`（コースティクス入りの影）
- 選択中 = `--smoke-fill` + `--smoke-filter`（ライトは brightness 0.44 で暗く、ダークは 1.45 で明るく）
- クラス: `.tab-glass`（ガラス面）、`.liquid-primary`（主ボタン: smoke＋内部コースティクス帯）、`.liquid-smoke`（選択インジケータ/選択チップ）、`.liquid-trough-on/off` + `.liquid-thumb`（スイッチ）
- Chromium では `@supports` ブロックが `backdrop-filter: url('#lgRefract')`（index.html の SVG 変位フィルタ）を重ねて**本物のDOM屈折**になる。他ブラウザは blur のみ。`backdrop-filter` 非対応は不透明フォールバック

### 角丸・影・タイポ
- 角丸は **7 / 9 / 12 px の3段**のみ（`rounded-sm|control`=7, `rounded-md|lg|card`=9, `rounded-xl|2xl|panel`=12）
- 影: `shadow-elev-1..4`（`--shadow-*`）。`shadow-glow-primary` はフォーカスの青い輪
- フォント: Manrope + Noto Sans JP、等幅は IBM Plex Mono。サイズキー: `micro`(10) `xs`(11) `sm`(13) `body`(14) `h3`(18) `h2`(22) `h1`(28) `display`(34)

## 3. コンポーネント（`src/components/ui/`）

| 部品 | 用途 | 備考 |
|---|---|---|
| `Card` / `Surface` | 面。フラットな白＋境界＋`shadow-elev-*` | `variant`: thin(沈んだ面)/regular/thick/chrome は影の段階。旧 `GlassCard`/`GlassSurface` |
| `Button` | ボタンの正本 | `primary`=リキッドガラス（tab-glass liquid-primary）。`tone` に部署キーを渡したときだけ単色。`secondary`=素のガラス、`ghost`、`glass`=フラット白、`danger`。旧 `GlassButton` |
| `Input` | テキスト入力 | フラット白＋focus でアクセント枠。ラベルは呼び出し側で `htmlFor` 紐付け必須。旧 `GlassInput` |
| `Badge` / `DeptBadge` | ラベル・ステータスピル | `tone`/`color` 無指定はニュートラル（bg-sunken）。旧 `GlassBadge` |
| `PageHeader` `EmptyState` `ErrorState` `Skeleton*` `Spinner` `StatusDot` `AmbientBackground` | 補助 | AmbientBackground は認証ページのみ |

旧 `Glass*` 名は**移行用シム**（同ファイル名で新実装を re-export）。全ページの import が新名称になったらシムを消す。`TabSwitch` と旧 `ui/Button` は削除済み — 排他タブは必ず `motion/LiquidTabs` を使う。

### モーション（`src/components/motion/`）
- `springs.ts` — スプリング値の正本（`indicator` / `morph` / `enter`）。数値を散らさない
- `LiquidTabs` — タブ/セグメント。**`id` 必須**（v1 の `layoutId="activeTab"` はグローバルで衝突した）。インジケータは位置と幅の両方を補間。`role=tablist`・矢印キー対応
- `ExpandableCard` — 押した場所から液体的に展開（`layoutId` 共有）。展開面は不透明な白
- `LiquidSwitch` — ON/OFF。trough がガラス、thumb は真珠
- すべて `useReducedMotion` を尊重。CSS 側も `prefers-reduced-motion` で即時切替

### テーマ切替
- デスクトップ: サイドバー下部の `theme-toggle/LiquidOrbToggle`（WebGPU のシャボン玉。`orb-runtime.gen.js` は生成物 — 手編集禁止、`demo/orb-gen/make-react-runtime.py` で再生成）。WebGPU 不可は CSS バブルに自動フォールバック
- モバイル: ヘッダーの簡易ボタン。状態は `store/themeStore`（`<html>` に `.dark`）
- `<theme-toggle>` Web Component（3状態 light/dark/clear）も同ディレクトリにあり、デモは `demo/theme-toggle.html`

## 4. レイアウトとテーマ

- シェルは `shell/AppShell` の1つだけ（サイドバー+トップバー+本文+MobileNav）。ルート追加は `shell/navConfig.ts`
- TOP (`/`) は最小: 指示入力＋入口4つ。**KPI の数字を置かない**（許可は承認件数ドットのみ）。密なダッシュボードは `/dashboard`
- モバイルで開けるのは `MOBILE_ROUTES`（/ /chat /deliverables）のみ。他は `DesktopOnly` が誘導
- ダーク: トークン経由なら自動で追従する。raw の white/black 透過（`bg-white/40` 等）を書かない。ダーク保証は v2 移行済み画面のみ（`src/taskmanager/**` は対象外）

## 5. アクセシビリティ（実装済みの前提を壊さない）

- `:focus-visible` はグローバル定義済み。**outline を消さない**
- 排他選択は LiquidTabs（radio 相当のキーボード操作込み）。自前 flex+button のタブ列を作らない
- モーダル: `role="dialog"` `aria-modal` `aria-labelledby`、Escape で閉じ、初期フォーカスと復帰
- ストリーミング/非同期状態は `aria-live="polite"`
- アイコンだけのボタンに `aria-label`
- コントラスト: 文字は `--text-muted` が下限（AA）。それより薄くしたければ文字ではなく装飾（`--ink-decorative`）

## 6. 検証

```bash
node apps/web/scripts/check-design-tokens.mjs   # hex 直書き 0 件であること
npm run build --workspace=apps/web              # ビルド
npx tsc --noEmit                                # 既知の赤（ImportMeta.env 等）以外を増やさない
```
