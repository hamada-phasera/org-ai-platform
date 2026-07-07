# org-ai-platform 部署別タスク表（ライブ版）

> このファイルが正本。全 worktree から `docs/tasks.md` として見える（dept ブランチは main から派生）。
> 各エージェントは自分のセクションのみ更新可。他部署のセクションは読むだけ。
> タスク完了時はチェックを入れ、同じコミットで成果物のパスを追記する。
> オーケストレーションの雛形一式は `docs/org-worktree/` を参照。

## 🗓 進め方（合意済みカデンス）

**サイクル1 = 3部署 薄いMVP縦切りを並列（2ラウンド R1→R2）→ フェーズ2で深化・先行**

- ワーカー画面は2枚（画面2/3）＋オーガナイザー（画面1）。3部署なので **2並列×ローテーション**。
  - 例: 画面2=営業, 画面3=分析 を R1 並列 → 先に空いた画面が SNS R1 に入る。
  - 3枚目のワーカー画面を開けば真の3並列も可。
- 各部署の縦切り＝「画面1枚 + 部署API + 主機能1つ + テスト」を R1→R2 で。
- フェーズ2は、サイクル1で確立したパターン・共有型を土台に1〜複数部署を深掘り。

## 📋 進捗ボード（オーガナイザーのみ「割当」欄を編集可）

| 部署 | ブランチ | 割当画面 | サイクル1状態 | PR |
|------|---------|---------|------|-----|
| 営業 | feat/sales-dept | 画面2 | 🟢 サイクル1完了(S-1〜S-4) | — |
| 分析 | feat/analytics-dept | 画面3 | ⚪ R1 未着手 | — |
| SNS | feat/sns-dept | （待機列→空き画面へ） | ⚪ R1 未着手 | — |
| 統合 | feat/integration | 画面1（オーガナイザー） | ⚪ 配線はR1完了分から随時 | — |

状態: ⚪ 未着手 / 🔵 作業中 / 🟡 ブロック中 / ✅ 完了・PR済み

> ワーカーは自分の行の「状態」「PR」のみ更新可。「割当画面」はオーガナイザーが決める。

## 🔒 共有コントラクト v0（暫定 — B=統合フェーズで正式確定）

**この節は全部署が従う。破ると衝突・境界違反になる。**

- **department 値域**: `SALES | ANALYTICS | SNS | GENERAL`（`Agent.department` の既定=GENERAL）。新値を勝手に足さない。
- **共有型の正本**: 暫定 `packages/shared-types`（`packages/shared` は作らない）。B で最終確定。
- **所有 vs 配線の分離（衝突防止の核）**:
  - 各部署が **所有＝編集可** なのは自分のページ実装と部署ルート実装のみ:
    - 営業: `apps/web/src/pages/Sales*.tsx` / `components/Sales/**` / `apps/api-gateway/src/routes/sales/**` / `tests/sales/**`
    - 分析: `apps/web/src/pages/Analytics*.tsx` / `components/Analytics/**` / `routes/analytics/**` / `usage-metrics-svc/**` / `tests/business/**`
    - SNS: `apps/web/src/pages/Sns*.tsx` / `components/Sns/**` / `routes/sns/**` / `tests/sns/**`
  - **根の配線ファイルは部署が触らない（B で統合が配線）**:
    - `apps/web/src/App.tsx`（`<Route>` 追加）
    - `apps/web/src/components/Layout.tsx` / `components/Navigation/**`（ナビ追加）
    - `apps/api-gateway/src/index.ts`（`app.register(...)` 追加）
    - `packages/shared-types/**` / `packages/db-schema/prisma/schema.prisma`（共有型・DBスキーマ）
  - 配線が必要になったら `docs/integration-requests.md` に「配線要求（ページ名 / ルートprefix / 必要な型）」を書く。
    C 中はページを直リンクせず **コンポーネント/ルート単体で動作確認** → B で App.tsx / index.ts に配線。
- **DBスキーマ**: 部署は prisma schema を編集しない。まず既存フィールド（`Agent.department` 等）で賄えるか検討し、無理なら integration-requests に書く。

## 運用ルール

- タスク粒度: 1タスク = 1〜3コミットで終わる大きさ
- 依存は `⛓ depends:` を明記（他部署/共有依存はローカルモックで先行）
- 作った関数には必ずテスト（正常系1 + エッジ1以上）
- コミット規約: `feat(sales|analytics|sns): ...` 等
- 共有変更は本ファイルではなく `docs/integration-requests.md`

---

## 🏷 営業部署（feat/sales-dept）

### サイクル1・R1（縦切りの土台）
- [x] S-1: `SalesPage.tsx` 追加 — `department="SALES"` の Agent/Task を read-only 一覧表示（既存 services/store 再利用、配線は B）
  - 成果物: `apps/web/src/pages/SalesPage.tsx`（useQuery で `/agents`・`/tasks` を取得しクライアント側で department 絞り込み。tsc 追加エラー 0）。配線は integration-requests #2。
- [x] S-2: `routes/sales/pipeline.ts` — 商談ステージ（リード→商談→提案→受注）の read/更新 最小API（register は B）
  - 成果物: `apps/api-gateway/src/routes/sales/pipeline.ts`（インメモリ store・prisma 非依存）+ テスト `apps/api-gateway/tests/sales/*.test.ts`（Vitest 12/12 pass）。共有型/DB化は integration-requests #1、登録は #2。

### サイクル1・R2（主機能＋テスト）
- [x] S-3: 提案書ドラフト生成（主機能）— deliverables + LLMRouter で生成。⛓ depends: `ProposalTemplate` 型（integration-requests へ、ローカルモック型で先行）
  - 成果物: `apps/api-gateway/src/routes/sales/proposals.ts`（AI Engine `/llm/chat` 経由で生成→AILog記録→`Task(taskType='proposal')` 保存）+ `proposal-templates.ts`（ローカル `ProposalTemplate` + 純粋ロジック）。共有型は integration-requests #4、AILog欠落は #5。
- [x] S-4: S-1〜S-3 のテスト（`tests/sales/`）
  - 成果物: `apps/api-gateway/tests/sales/*.test.ts` — Vitest **24/24 pass**（S-2 pipeline 12 + S-3 proposals/templates 12）。※S-1(SalesPage) は web にテストランナーが無く（追加は非所有の apps/web/package.json に触れる）宣言的UIのため単体テストは保留、B の web テスト基盤整備待ち。

### フェーズ2（深化・後続）
- [ ] S-5: パイプラインのドラッグ操作UI / 商談確度スコアリング
- [ ] S-6: 顧客別 営業エージェント設定（Agent.steps テンプレート）

## 📊 分析部署（feat/analytics-dept）

### サイクル1・R1
- [ ] A-1: イベントスキーマ v1 **提案のみ**（AILog/ExecutionLog/TaskLog 土台に部署別KPIイベント定義 → integration-requests。発火は後）
- [ ] A-2: `AnalyticsPage.tsx` 追加 — まず既存 dashboard API 流用で部署別の実行数/コスト/成功率を read-only 表示（配線は B）

### サイクル1・R2
- [ ] A-3: `usage-metrics-svc` に部署別集計エンドポイント追加（Go, read-only AILog）→ AnalyticsPage を接続
- [ ] A-4: `tests/business/` にイベント発火テスト（A-1 スキーマ準拠）

### フェーズ2（深化・後続）
- [ ] A-5: 時系列/期間フィルタ・部署横断比較
- [ ] A-6: KPIアラート（governance / RiskEvent 連携）

## 📣 SNS投稿部署（feat/sns-dept）

### サイクル1・R1
- [ ] N-1: `SnsPage.tsx` 追加 + 投稿下書き生成（主機能, LLMRouter, Instagram/X フォーマット別）を最小で（配線は B）
- [ ] N-2: 承認待ちキュー UI — 自動投稿しない・**承認フロー必須**。Task の承認状態を read + 承認/却下

### サイクル1・R2
- [ ] N-3: コンテンツカレンダー画面（下書きを日付にひも付け表示）
- [ ] N-4: 文字数/ハッシュタグ整形のエッジケーステスト（`tests/sns/`）

### フェーズ2（深化・後続）
- [ ] N-5: プラットフォーム追加（LinkedIn 等）/ 画像添付
- [ ] N-6: 承認→予約投稿（scheduled-tasks 連携、投稿は承認後のみ）

## 🔗 統合フェーズ（feat/integration — オーガナイザー / R1完了分から随時配線）

- [ ] I-0: 配線（各部署のR1完了ごとに App.tsx / Layout ナビ / index.ts へ登録）
- [ ] I-1: 横断整合性レビュー（→ `docs/integration-review.md`）
- [ ] I-2: integration-requests.md の消化・shared-types 正本確定・shared 昇格
- [ ] I-3: マージ順序の決定と rebase 指示
- [ ] I-4: マージ後の統合テスト実行
