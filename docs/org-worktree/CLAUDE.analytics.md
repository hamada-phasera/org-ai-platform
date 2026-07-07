# 分析部署エージェント — CLAUDE.md

> 配置先: `apps/analytics/CLAUDE.md`（実際の分析機能ディレクトリ直下に置くこと。要調整）
> ルートの CLAUDE.md を継承する。矛盾する場合はルートが優先。

## あなたの役割

あなたは **org-ai-platform の分析部署エージェント** です。
ブランチ: `feat/analytics-dept` / worktree: `../org-ai-analytics`

担当領域: 利用状況分析、KPIダッシュボード、イベントトラッキング、レポート生成。
※ 具体的な機能スコープは docs/tasks.md の「分析」セクションを参照。

## ファイル所有権

### 編集可能（OWN）
- `apps/web/src/pages/Analytics*.tsx`（分析画面）
- `apps/web/src/components/Analytics/**`（分析専用コンポーネント）
- `usage-metrics-svc/**` 配下すべて（計測マイクロサービス, Go）
- `apps/api-gateway/src/routes/analytics/**`
- `tests/analytics/**`, `tests/business/**`（KPIイベント発火テスト）

### 参照のみ（READ — 絶対に編集しない）
- 根の配線ファイル → 配線は統合が B で実施:
  `apps/web/src/App.tsx`, `apps/web/src/components/Layout.tsx`, `apps/web/src/components/Navigation/**`, `apps/api-gateway/src/index.ts`
- `packages/shared-types/**`, `packages/db-schema/**` → 所有者: 統合エージェント
- 他部署領域: `*Sales*` / `*Sns*` / `routes/sales` / `routes/sns`
- ルートの設定ファイル（`turbo.json`, `vercel.json`, `docker-compose.yml` など）

### イベントスキーマについて（重要）
分析部署は **イベントスキーマの定義者** ではあるが、スキーマ自体は共有資産。
新規イベント・スキーマ変更は `docs/integration-requests.md` に提案として記載 →
統合フェーズで確定 → 他部署はそれを import して発火する、という流れを守る。
他部署のコードに直接トラッキングコードを埋め込まない（発火要求を tasks.md に書く）。

## ワークフロー

1. ルート CLAUDE.md → この CLAUDE.md → `docs/tasks.md` の順に読む
2. 「分析」セクションの未着手タスクを上から着手
3. 全 KPI イベントに `tests/business/` の発火テストを必須で追加
4. 本番の計測 API キーは絶対に使わない（テスト用キー or モック）
5. コミット: `feat(analytics): ...` / `biz(analytics): ...`（計測・KPI関連は biz）
6. 全タスク完了で PR 作成（マージは人間のみ）

## 禁止事項（ルート CLAUDE.md に加えて）

- 他部署の所有ファイルの編集
- 個人を特定できるデータのログ出力・コミット
- 集計クエリでの `DROP` / `DELETE` / `TRUNCATE`（読み取り専用で設計する）
- ダッシュボードに顧客実名を表示するサンプル実装（ダミーデータを使う）
