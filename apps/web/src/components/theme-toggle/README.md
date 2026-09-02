# `<theme-toggle>` — Liquid Glass テーマ切替トグル

角丸バーの上を、シャボン玉のレンズがスライドして `light / dark / clear` を切り替える
Web Component。**依存ライブラリなし**。レンズは操作したときだけ動き、移動中に
下のラベル文字を屈折させる。アイドル時のアニメーションはゼロ。

## 使い方

```html
<link rel="stylesheet" href=".../theme-toggle/theme-toggle.css" />
<script type="module" src=".../theme-toggle/theme-toggle.js"></script>

<!-- レンズがバーの上下から約11pxずつはみ出すので、周囲に余白を取る -->
<theme-toggle></theme-toggle>
```

- 状態は `<html data-theme="light|dark|clear">` に反映される。既存アプリ
  （Tailwind `darkMode:'class'`）との互換のため `.dark` クラスも同期する。
- 永続化は `localStorage("tt-theme")`。初期値は保存値 →
  無ければ `prefers-color-scheme`。
- JS API: `el.setTheme('dark')` / `el.theme`。切替時に `themechange`
  イベント（`detail.theme`、バブルする）を発火。
- デモ: `demo/theme-toggle.html`（vite dev で `/demo/theme-toggle.html`。
  file:// は ES module が CORS で塞がれるため不可）。
  `?stage=bar` でレンズを隠しバーだけ確認できる。

## キーボード操作

`role="radiogroup"` / `role="radio"` / `aria-checked`。

- **Tab** — グループへ入る（選択中のセグメントにフォーカス）
- **← →** — フォーカス移動のみ（選択は変えない）
- **Enter / Space** — 決定（レンズが移動）

## CSS変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `--tt-height` | `56px` | バーの高さ |
| `--tt-width` | `240px` | バーの幅（動画準拠の2状態なら 220px 相当） |
| `--tt-lens-ratio` | `1.35` | レンズ径 = 高さ×比率。バーからはみ出す |
| `--tt-move-ms` | `460ms` | レンズ移動時間 |
| `--tt-fade` | `500ms` | バー面のテーマクロスフェード |
| `--tt-accent` | `#101521` | 予備（フォーカスリング等の拡張用） |

テーマ別のバー面・ラベル色は `html[data-theme=...] theme-toggle { --tt-bar-* }`
で上書きできる。

## 動きの設計（アイドル完全静止の保証）

- 駆動は「状態変化 → `.is-moving` 付与 → CSS transition/animation →
  `animationend` でクラス除去」の一方向。**JS で rAF をループさせない**
  （初期化時に transition を有効化する1回だけ使用）。
- 移動はオーバーシュートする cubic-bezier ＋ squash & stretch のキーフレーム。
- 屈折の「中間で最大」は、強フィルタを持つ第2レンズ層の opacity を
  `0→1→0` にキーフレームして実現（JSで filter 属性は書き換えない）。
- `prefers-reduced-motion: reduce` ではスライド 0.01s・屈折変化なし。

## 屈折のしくみと対応ブラウザ

- 変位マップは **feTurbulence ではなく放射状レンズマップ**。
  R=横ランプ／G=縦ランプを data-URI SVG で `feImage` に与え、
  中心と最外周は中立(128)に戻して「縁だけ曲がる」レンズにしている。
- 色収差は `feColorMatrix` でRGB分解 → R/B を `feOffset` ±1px → screen 合成。
- `backdrop-filter: url(#…)` は **Chromium 系のみ**。素のぼかしはレンズ本体が
  持ち、変位は専用レイヤーだけが持つ分離設計なので、Safari / Firefox では
  変位層が無効化されるだけでガラス自体は劣化しない（さらに `@supports` で
  blur(2px)+saturate を明示フォールバック）。

| ブラウザ | 見た目 |
|---|---|
| Chrome / Edge / Arc（Chromium） | 屈折＋色収差＋ガラス（フル） |
| Safari / Firefox | ガラス（blur+saturate）。屈折なし |
| `backdrop-filter` 非対応 | 半透明の面のみ |

## 動画と違う判断

| 判断 | 理由 |
|---|---|
| 3状態（バー3分割・幅240px） | 仕様書の拡張要件。2状態なら220pxで動画どおり |
| shadow DOM 不使用（light DOM + `.tt-` 接頭辞） | `backdrop-filter: url(#id)` の shadow 境界越え解決が Chromium で不安定なため、文書直下の defs を確実に参照させる |
| 移動中の屈折切替は2枚レンズ層の opacity クロスフェード | JSで filter 属性を書き換えるより「クラス付与→CSS」の一方向が保てる（仕様書が許容する2枚構成） |
| 選択中セグメントのラベルは非表示 | レンズ内のアイコンが状態を代表する（動画の「アイコンはレンズの中」準拠）。ラベルは残り2セグメントに常時表示 |
| SVG defs は文書内で1組のみ生成 | 複数トグル設置時の id 重複を防ぐ。同一ページに複数置く場合も動作するが、想定は1つ |

## 検証記録（demo/verify/）

- `verify-1-light-idle.png` / `verify-2-mid-move.png`（ラベルが歪む中間コマ）/ `verify-3-dark-idle.png`
- アイドル静止: 1秒おき2枚のピクセル差分 **0 / 504,000 px**
- キーボードのみで light→dark→clear→light の一周を確認（`aria-checked` 追従）
- reduced-motion: クリックと同時に着地・屈折move層 `display:none`（media query 反転コピー `verify/rm-test.html` で確認）
- Safari相当: `verify/safari-test.html` で blur(2px)+saturate フォールバックを確認（`verify-5-safari-fallback.png`）
