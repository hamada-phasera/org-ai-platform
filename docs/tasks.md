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

| 部署 | ブランチ | 割当画面 | サイクル1状態（B統合 2026-07-08） | PR |
|------|---------|---------|------|-----|
| 営業 | feat/sales-dept | — | ✅ R1+R2完了 → **B統合済**（配線+検証） | — |
| 分析 | feat/analytics-dept | — | ✅ R1+R2完了（A-1〜A-4）→ **B統合済** | — |
| SNS | feat/sns-dept | — | ✅ R1+R2完了（N-1〜N-4・37tests）→ **B統合済** | — |
| 統合 | feat/integration | 画面1（オーガナイザー） | ✅ 3部署マージ+配線+検証（fe786cb・web/api/go build green・95/96 test）。残: prisma/shared-types昇格🟡（→ integration-review.md） | — |

状態: ⚪ 未着手 / 🔵 作業中 / 🟡 ブロック中 / ✅ 完了・PR済み

> ワーカーは自分の行の「状態」「PR」のみ更新可。「割当画面」はオーガナイザーが決める。

## 🔒 共有コントラクト v0（暫定 — B=統合フェーズで正式確定）

**この節は全部署が従う。破ると衝突・境界違反になる。**

- **department 値域（訂正 2026-07-07）**: 実正本 `packages/shared-types` の `AgentDepartment` = `SALES | MARKETING | ACCOUNTING | ANALYTICS | GENERAL`（当初契約の `SNS` は誤り＝コードに存在しない。両部署が検出: sales#3 / analytics#2）。**SNS投稿部署の成果物 `department = 'MARKETING'`**（確定 2026-07-07）。UI名（`SnsPage` 等）はそのままで可、データ次元のみ MARKETING に寄せる。新値を勝手に足さない。
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
- [x] A-1: イベントスキーマ v1 **提案のみ**（AILog/ExecutionLog/TaskLog 土台に部署別KPIイベント定義 → integration-requests。発火は後）→ 成果物: `docs/integration-requests.md` #1(KPIイベント型),#2(department値域不一致) / `apps/web/src/components/Analytics/kpiEvents.ts`（ローカルモック, commit 346cc5b）
- [x] A-2: `AnalyticsPage.tsx` 追加 — まず既存 dashboard API 流用で部署別の実行数/コスト/成功率を read-only 表示（配線は B）→ 成果物: `apps/web/src/pages/AnalyticsPage.tsx` + `components/Analytics/**`。実行数=実装済(/dashboard/efficiency流用)、コスト・成功率=データ源不在のため A-3 接続予定として明示（捏造なし, commit 188e018）

### サイクル1・R2
- [x] A-3: `usage-metrics-svc` に部署別集計エンドポイント追加（Go, read-only AILog）→ AnalyticsPage を接続（blocker解除済 2026-07-07: 統合が usage-metrics-svc を main に取り込み）→ 成果物: `GET /metrics/departments`（raw+rollup 両経路, go test 全green, a52dc88）/ gateway プロキシ `routes/analytics/`（JWT orgId 強制・登録はB→#A3, d4479a3）/ `DepartmentCostCard` ライブ化+未接続時自動劣化（vite build green, 7171556）
- [x] A-4: `tests/business/` にイベント発火テスト（A-1 スキーマ準拠）→ 成果物: `routes/analytics/kpi-events.ts`（発火純関数+レガシー部署名正規化+rollup）/ `apps/api-gateway/tests/business/kpi-events.test.ts` 20ケース green（分析計25/25, df1c0e7）

### フェーズ2（深化・後続）
- [ ] A-5: 時系列/期間フィルタ・部署横断比較
- [ ] A-6: KPIアラート（governance / RiskEvent 連携）

## 📣 SNS投稿部署（feat/sns-dept）

### サイクル1・R1
- [x] N-1: `SnsPage.tsx` 追加 + 投稿下書き生成（主機能, LLMRouter, Instagram/X フォーマット別）を最小で（配線は B）
  - 成果物: `apps/api-gateway/src/routes/sns/posts.ts`（`/llm/chat` json_mode 経由生成→AILog→`Task(taskType='sns', dept='MARKETING', status='PENDING_APPROVAL')` 保存）+ `routes/sns/format.ts`（X/Instagram/LinkedIn 文字数・ハッシュタグ整形・検証・プロンプト、純粋）+ `apps/web/src/pages/SnsPage.tsx`。vocab方針(dept=MARKETING+taskType='sns')は integration-requests #S1、配線は #S2。commits: `ab776e6`(api routes) / `fed3f5f`(SnsPage)。
- [x] N-2: 承認待ちキュー UI — 自動投稿しない・**承認フロー必須**。Task の承認状態を read + 承認/却下
  - 成果物: `routes/sns/posts.ts` GET `/queue` + POST `/:id/approve` `/:id/reject`（**状態遷移のみ・dispatch/投稿なし**。実行を伴う既存 `/tasks/:id/approve` は流用せず新設）+ SnsPage 承認/却下UI。テストで「承認時に外部呼び出しが起きない」ことを保証。※N-4(文字数/ハッシュタグ エッジテスト)相当は `tests/sns/format.test.ts` で先行実装済み。commits: `ab776e6`(api routes) / `fed3f5f`(SnsPage) / `09cc3f1`(tests, 19 pass)。

### サイクル1・R2
- [x] N-3: コンテンツカレンダー画面（下書きを日付にひも付け表示）
  - 成果物: `apps/api-gateway/src/routes/sns/calendar.ts`（JST日付キー/グルーピング、純粋）+ posts.ts に GET `/calendar`（日付グルーピング）と PATCH `/:id/schedule`（scheduledAt 差し込み・**メタデータのみ/投稿しない**）+ `apps/web/src/components/Sns/SnsCalendar.tsx`（月グリッド）+ SnsPage に リスト/カレンダー切替。新エンドポイントは既存 snsPostsRoutes 内なので追加配線不要（#S2 のまま）。予約日時の第一級カラム化は integration-requests #S4（output JSON でローカル先行）。commit: `cb72edf`。
- [x] N-4: 文字数/ハッシュタグ整形のエッジケーステスト（`tests/sns/`）
  - 成果物: `tests/sns/format.test.ts`（正規化/検証/境界値 X 280・281/IG 30・31/LinkedIn 3000・3001/絵文字UTF-16/空入力/タグ内サロゲート除去）+ `tests/sns/calendar.test.ts`（JST丸め/scheduledAt優先/グルーピング）+ posts.route.test.ts に calendar/schedule ルートテスト追加。SNS スイート **Vitest 37/37 pass**。commits: `f1bee03`(初版) / `b216e46`(追加エッジ)。

### フェーズ2（深化・後続）
- [ ] N-5: プラットフォーム追加（LinkedIn 等）/ 画像添付
- [ ] N-6: 承認→予約投稿（scheduled-tasks 連携、投稿は承認後のみ）

## 🔗 統合フェーズ（feat/integration — オーガナイザー / R1完了分から随時配線）

- [x] I-0: 配線完了 — App.tsx 3ルート / index.ts 4登録（ナビは phase-2）→ `fe786cb`
- [x] I-1: 横断整合性レビュー → `docs/integration-review.md`（2026-07-08）
- [~] I-2: 一部消化（vocab=MARKETING / 配線 / コンプラ#5 解決済）。**shared-types 昇格＋prisma migration は🟡残**（integration-review 参照）
- [x] I-3: マージ順推奨 — feat/integration を1単位で main 取込 / deploy・origin push は人間（#2）
- [x] I-4: 統合テスト — web `vite build`✅ / api `tsc --noCheck`✅ + vitest 95/96（1件は既存agents失敗）/ `go test`✅

## 🧾 統合(B) 決定ログ

- **2026-07-07 department 語彙**: 実正本 `AgentDepartment` = `SALES|MARKETING|ACCOUNTING|ANALYTICS|GENERAL` を採用。SNS投稿部署の成果物は `department='MARKETING'`（UI名は SnsPage のまま）。→ 営業#3 / 分析#2 クローズ。
- **2026-07-07 コンプラ 営業#5**: `/llm/chat` の AILog 未記録を中央修正すると決定。`feat/integration` で ai-engine `/llm/chat` に `log_llm_call` を追加（riskScore/RiskEvent 込み）。各部署の best-effort 個別ロギングは昇格後に撤去。→ 実装は feat/integration、マージは人間承認。
- **B残タスク（他部署R1が揃ってから一括）**: 営業#1 Deal型+Prisma Dealモデル(migration) / 営業#4 ProposalTemplate型+`taskType='proposal'`予約 / 分析#1 KPIイベント型+DepartmentKpi(コスト単価表=要Anthropicレート)。配線(営業#2)は各dept branchのマージ時に実施。
- **2026-07-07 分析ブロッカー解除**: `feature/usage-metrics-svc`（Go, 29ファイル）を `feat/integration` にマージ（`55c3871`・main比コンフリクトなしの純加算）→ FF main。分析ワーカーは `git rebase main`（または merge main）で usage-metrics-svc を取り込み A-3 着手可。
- **2026-07-07 SNS 起動**: 画面2（営業完了で空き）に SNS を割当。R1（N-1/N-2）をサブエージェントworkerで着手（`org-ai-sns`・feat/sns-dept・dept=MARKETING・配線は触らない）。※ 同 worktree を人手で二重起動しないこと。
- **2026-07-07 #2 確定: ローカルB統合のみ**: `origin` に push しない。3部署R1(+営業/分析R2)が揃ったら feat/integration へ順次マージ＋配線し、`docs/integration-review.md` にマージ順提案。GitHub PR/デプロイ（要 main→origin push）は後日あなたが実施。
- **2026-07-07 SNS R1完了**: N-1(下書き生成 IG/X/LinkedIn)・N-2(承認キュー PENDING_APPROVAL、自動投稿なし)。境界クリーン・19tests pass。要求 #S1(vocab/taskType)・#S2(配線+TaskStatus昇格)・#S3(/llm/chat AILog=コンプラ#5と同件、統合済で解消見込)。
