# FLOW Design System v3 — Stripe風モダンSaaS（白基調＋ブルーバイオレット）

> **目的**: `org-ai-platform` のデザインの単一の情報源。
> コードを書く前にこれを読み、ここにあるトークンとコンポーネントだけを使うこと。
> **値の正本はコード側**: 色・影は `apps/web/src/index.css`、Tailwind キーは
> `apps/web/tailwind.config.js`、モーションは `apps/web/src/components/motion/springs.ts`。
> 承認済みモックの正本は `design-canvas/stripe-v3/`（公開キャンバス: そのREADME参照）。

履歴: v1 "Liquid Glass Prism"（虹グラデ）→ v2 "塗らないリキッドガラス"（2026-08、ダークモード付き）→
**v3（2026-09、現行）**。v2 のガラス・スモーク・ダークモードは**全廃**。`tab-glass` / `liquid-*` /
`dark:` / `backdrop-filter` が生えたら退行 — `npm run check:tokens` が検出する。

---

## 1. 原則

| 原則 | 意味 |
|---|---|
| **不透明な白＋ソフトシャドウ** | 面は白 `--surface` ＋ 罫線 ＋ 影3段。半透明・backdrop-filter は使わない |
| **青は導く色** | ブランドの `#635BFF`（`--action`=`--accent`）は主ボタン・選択・リンクにだけ塗る。**塗り面積は小さく**、主役は白とインク |
| **グラデは3pxストリップだけ** | `--grad`（cyan→blurple→pink）は `.brand-strip`（ヒーロー・モーダル上端）専用。面には塗らない |
| **ダークモードなし** | ライトのみ。テーマトグルは置かない |
| **数字は等幅** | 金額・件数・%が縦に並ぶ場所は `font-mono` か `.tabular` |

## 2. トークン（`src/index.css` が正本）

- 面: `bg-canvas`(#f6f9fc) / `bg-elevated`(#fff) / `bg-sunken`、罫線: `border-border`(#e6ebf1) / `border-border-strong`
- 文字: `text-primary`(#0a2540) / `text-secondary`(#425466) / `text-muted`(#687385 — **文字色の下限**) / `text-ink-decorative`（文字に使わない。罫線・装飾専用）
- アクション/アクセント: `bg-action`+`hover:bg-action-hover`（=#635BFF）、`accent-soft` / `accent-soft-border` は選択面
- 影: `shadow-elev-1..4`（Stripe風ソフトシャドウ。カード=1、浮いた面=2、モーダル=3〜4）
- 角丸: **8 / 12 / 16 の3段**（`rounded-sm|control`=8, `rounded-md|lg|card`=12, `rounded-xl|2xl|panel`=16）
- 意味色: `success`/`warning`/`danger`/`info`（CSS変数＋`*-rgb`三つ組。`bg-danger/10` 等のアルファ修飾が使える）
- 部署色（データの色）: `constants/departments.ts` の `DEPT_ACCENT`/`DEPT_LABEL`、外部ブランド色は `constants/brand.ts`。**この2ファイル以外に hex を書かない**
- セグメントのトラック: `--seg-track`（=`bg-sunken` と同系）
- フォント: **Figtree + Noto Sans JP**（index.html で読み込み）、等幅 IBM Plex Mono

## 3. コンポーネント（`src/components/ui/`）

| 部品 | v3 での姿 |
|---|---|
| `Card` / `Surface` | 白＋罫線＋`shadow-elev-*`。variant thin/regular/thick/chrome は影の段階 |
| `Button` | `primary`=#635BFF塗り＋inset ハイライト、`secondary`=白＋強罫線、`ghost`、`glass`=フラット白（歴史的名称）、`danger` |
| `Input` | 白＋罫線、focus でアクセント枠。`htmlFor` 紐付け必須 |
| `Badge` / `DeptBadge` | tone 無指定はニュートラル。意味色 tone（success 等）は color-mix で淡色地 |
| `PageHeader` `EmptyState` `ErrorState` `Skeleton*` `StatusDot` | v3 トークンで着色済み |
| `.brand-strip` | 3px のブランドグラデ。モーダル上端（-mx-6 -mt-6 で貼る）とヒーローに |

### モーション（`src/components/motion/`）
- `springs.ts` — スプリング値の正本（indicator / morph / enter）
- `LiquidTabs` — **名前は歴史的だが実体はセグメントコントロール**: 沈んだトラック＋選択中は白い面＋影。`id` 必須（layoutId 衝突防止）、矢印キー対応。排他選択は必ずこれを使う（自前 flex+button のタブ列を作らない）
- `ExpandableCard` — 押した場所から展開（layoutId 共有）。面は不透明な白

### 部署トグル（トップバー常設）
`AppShell` の header に `LiquidTabs id="global-dept"`（すべて＋5部署）。選択は
`store/deptFilterStore.ts` に載る。実データ連動は現状チャット（送信 department）のみで、
他ページへの連動は受信箱スプリントで拡張予定。

## 4. レイアウト

- シェルは `shell/AppShell` の1つ（サイドバー＋部署トグルのトップバー＋本文＋MobileNav）。ルート追加は `shell/navConfig.ts` の表だけ（各行の `mobile: 'exact' | 'prefix' | false` と `tab`）。サイドバー・下部タブ・メニュー・`isMobileRoute` はすべてこの表から出す。ルートを足したら `shell/__tests__/navConfig.test.ts` の表にも足す（App.tsx と突き合わせて落ちる）
- サイドバー選択中 = `bg-accent-soft text-accent`
- TOP (`/`) は最小: 指示入力＋業務キャンバス（PC は `@xyflow/react` のノードと線、スマホは同じ内容の縦リスト。`components/canvas/`・docs/design/canvas-home.md）。KPI数字は置かない（例外は承認件数のみ）
- 初回の案内は TOP の入力欄の直下に区切り線の一覧で最大3行（指示・連携・招待。権限で絞る）。完了は既存 API から導出し、全部完了か閉じたら出さない（`shell/Onboarding.tsx`、判定は `utils/onboarding.ts`）
- 全画面の高さは `h-dvh` / `min-h-dvh`（`h-screen` は使わない）。下部ナビと本文の下余白は `env(safe-area-inset-bottom)` を足す（viewport は `viewport-fit=cover`）
- モバイルで開けるのは `mobile` が付いた行だけ、他は `DesktopOnly`。分担は「閲覧・承認・チャット・契約（設定）・経理の確認・エージェントの一覧と実行はスマホ、エージェント詳細・ガバナンス・タスク・営業・分析・SNS はパソコン」
- スマホでは表を縦積みの行にする（`lg:hidden` の一覧と `hidden lg:block` の表）。横スクロールを出さない。トークン貼り付けなど長い入力はパソコンだけに出す

## 5. アクセシビリティ

- `:focus-visible` はグローバル定義済み。outline を消さない
- モーダル: `role="dialog"` `aria-modal` `aria-labelledby`、Escape、初期フォーカスと復帰
- ストリーミング/非同期状態は `aria-live="polite"`、アイコンだけのボタンに `aria-label`
- コントラスト: 文字は `--text-muted` が下限（キャンバス地で4.9:1）
- 押せる要素はスマホ（lg 未満）で 44px 以上。`Button` と `LiquidTabs` は `max-lg:min-h-11` / `max-lg:h-11` を内蔵。素の `<button>` `<select>` は `h-11 w-11` か `max-lg:min-h-11` を付ける
- 入力欄はスマホで 16px 以上（iOS が拡大して戻らなくなる）。`Input` は `max-lg:text-base` を内蔵。素の `<input>` `<textarea>` は `max-lg:text-base` を付ける。認証画面は `autoComplete` と `inputMode` を付ける

## 6. 検証

```bash
npm run check:tokens --workspace=apps/web   # hex直書き・dark:・ガラス残骸 = 0
npm run build --workspace=apps/web
npx tsc --noEmit                            # 0 エラーを維持（ベースライン0達成済み）
```
