# デプロイ手順書 — サイクル1統合 2026-07-08

> コードは E2E 合格・統合済み（`main`）。デプロイは **Render 支払い未完了で停止中**のためブロック。
> Render 復旧後にこの手順で一発仕上げできるようにまとめる。

---

## 追記 2026-07-24 — スキーマ昇格（Deal / Task.scheduledAt）を含むデプロイ

ブランチ `claude/current-status-check-bwez6d` で **Prisma スキーマ昇格**を実施済み。次回デプロイで自動反映される。

### 何が変わったか
- **新マイグレーション** `packages/db-schema/prisma/migrations/20260724000000_add_deal_and_task_scheduled_at/`
  - `Deal` テーブル新設（営業パイプラインの商談。従来はインメモリ Map で再起動消滅 → 永続化）。
  - `Task.scheduledAt TIMESTAMP(3)` カラム + `@@index([orgId, scheduledAt])`（SNS 予約投稿日時。従来は output JSON 内）。
- **すべて追加操作のみ**（`ADD COLUMN`(NULL可) / `CREATE TABLE` / `CREATE INDEX` / 新規テーブルへの `FK`）。
  既存行に破壊的変更なし。`prisma migrate diff` で Prisma 生成物と一致することを確認済み。
- `routes/sales/pipeline.ts` は `prisma.deal` を使用（純粋ロジックは `pipeline-core.ts` に分離）。
  SNS `PATCH /schedule` は `scheduledAt` カラムに書き込み、`calendar.ts`/フロントは
  **カラム優先 → 旧 output JSON フォールバック**で読むため既存下書きも消えない。
- `Task.status` は **String カラムのまま**（`shared-types` の `TaskStatus` を8値に拡張して型で担保）。
  DB enum 化は本番 `migrate deploy` 失敗リスク（既存行に想定外値があるとキャスト失敗＝gateway 起動不能）を避けて**意図的に見送り**。

### デプロイ時の追加確認（本体手順は下記「手順」節に従う）
- Render gateway の `startCommand` は `prisma migrate deploy` を含む → 起動時に `20260724000000` が自動適用される（追加のみなので冪等・安全）。
- ローカル検証済み: api-gateway `vitest` **100/100 pass** / `tsc --noEmit` クリーン / gateway `tsc --noCheck` / web `vite build` すべて green。
- **スモーク追加項目**:
  - `/sales`: 商談を作成 → **サービス再起動後も一覧に残る**（永続化の確認。従来は消えていた）。
  - `/sns`: 下書き → `PATCH /schedule` で日付設定 → カレンダーに反映。旧下書き（output JSON に日付）も引き続き表示されること。

## 現状
- 統合コード = `main`（feat/integration と同一）。3部署バーティカル + 配線 + compliance + usage-metrics-svc。
- ローカルフルE2E合格（営業/SNS/分析すべて実DBで動作確認済み）。
- コードレビュー用: `preview/cycle1-integration` を origin(hamada-phasera) に push 済み。

## デプロイ構成（実態）
- **フロント**: Vercel プロジェクト `flow`（team=hamahiro1668s-projects）。**Git自動連携ではなく `vercel` CLI 手動デプロイ**。
- **バック**: Render `render.yaml` の3サービス（`org-ai-api-gateway` / `org-ai-ai-engine` / `org-ai-n8n`）。**← 支払い未完了で停止中（要復旧）**。
- env は全て Render/Vercel ダッシュボード管理（`sync:false`）。本番 `DATABASE_URL`=Neon prod（`gentle-flower-96128672` の default 枝）、`ANTHROPIC_API_KEY`、`JWT_SECRET`、`N8N_*` 等。

## ⚠️ ブロッカー / 前提
1. **Render 支払い解決**（or 代替ホスト）。これが無いとバックが動かず、フロントだけ出しても新API不達。
2. アカウント差異に注意: Vercel=hamahiro1668 / GitHub origin=hamada-phasera（別）。CLI デプロイは hamahiro1668。
3. デプロイは**安定ネットワーク環境**から（本セッションのローカルは外向きネットが不安定で Vercel/Render 監視がフレーキー）。

## 手順（Render 復旧後）
### 1. バックエンド（Render）
- Render ダッシュボードで支払い復旧 → 3サービスを統合コミット（main）で Deploy。
  - デプロイ枝を統合に向ける、or 手動 Deploy latest。
- prod Neon への `prisma migrate deploy` は冪等（既に最新なら no-op）。
- usage-metrics-svc の独自 `schema.sql`（rollup テーブル）を prod DB に適用（未適用だと rollup worker が警告・raw read は動く）。
- 復旧確認: `GET https://<api-gateway>/api/...`（401 が返れば起動OK）。

### 2. フロント（Vercel `flow`）
```bash
cd <integration worktree>          # main と同一内容のツリー
# .vercel/project.json が flow を指すこと（無ければ cp ルートの .vercel）
vercel deploy            # ← Preview。URL で表示確認
vercel deploy --prod     # ← 本番昇格（or vercel promote <preview-url>）
```
- `FRONTEND_URL`（Render api-gateway の CORS）に Vercel 本番ドメインを含める。
- web の API 参照は本番 api-gateway URL（`VITE_API_URL` or プロキシ）を確認。

### 3. スモークテスト（本番）
- register/login → `/sales`（商談作成/遷移）→ `/sns`（下書き→承認）→ `/analytics`（部署KPI）。
- AILog 記録・RiskEvent（PII時）を確認。

## 検証ログ（ローカルE2E・合格）
- 営業: pipeline 作成/取得/ステージ遷移 + 提案テンプレ → 200/201。
- SNS: 下書き→queue→承認(APPROVED, 自動投稿なし)→queue消滅 → 実DB確認。
- 分析: gateway→usage-metrics-svc→AILog集計（コスト/レイテンシKPI）→ 200。
- ビルド: web `vite build` / api `tsc --noCheck` / go `go test` すべて green。テスト 95/96（1件は既存 agents 債務・Bの回帰でない）。

## 次サイクルの実装予定（n8n・別docs）
`docs/n8n-integration-design.md` の D1（生成系をTask/dispatch化）・D2（SNS段階1=投稿準備まで）。
