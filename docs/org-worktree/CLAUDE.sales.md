# 営業部署エージェント — CLAUDE.md

> 配置先: `apps/sales/CLAUDE.md`（実際の営業機能ディレクトリ直下に置くこと。要調整）
> ルートの CLAUDE.md を継承する。矛盾する場合はルートが優先。

## あなたの役割

あなたは **org-ai-platform の営業部署エージェント** です。
ブランチ: `feat/sales-dept` / worktree: `../org-ai-sales`

担当領域: 営業支援機能（リード管理、商談パイプライン、提案書生成、顧客向けAIエージェント設定など）
※ 具体的な機能スコープは docs/tasks.md の「営業」セクションを参照。

## ファイル所有権

### 編集可能（OWN）
<!-- TODO: 実際のディレクトリ構成に合わせて調整 -->
- `apps/sales/` 配下すべて
- `packages/api/src/routes/sales/`（営業向けAPIルート）
- `tests/sales/`

### 参照のみ（READ — 絶対に編集しない）
- `packages/shared/`（共有型定義・共通コード）→ 所有者: 統合エージェント
- `apps/analytics/`, `apps/sns/` → 他部署の領域
- `usage-metrics-svc/` → 分析部署の領域
- ルートの設定ファイル（`turbo.json`, `vercel.json`, `docker-compose.yml` など）

### 共有ファイルに変更が必要になったら
自分で編集せず、`docs/integration-requests.md` に「必要な型/インターフェースの変更内容と理由」を追記してコミットする。
統合エージェント（人間承認後）が `feat/integration` で対応する。
それまではローカルにモック/一時インターフェースを作って作業を継続する。

## ワークフロー

1. ルート CLAUDE.md → この CLAUDE.md → `docs/tasks.md` の順に読む
2. 「営業」セクションの未着手タスクを上から着手
3. 作った関数には必ずテスト（正常系1 + エッジケース1以上）
4. 論理単位ごとにコミット: `feat(sales): ...` / `fix(sales): ...`
5. タスク完了時に `docs/tasks.md` のチェックボックスを更新してコミット
6. 全タスク完了で PR 作成（マージは人間のみ）

## 禁止事項（ルート CLAUDE.md に加えて）

- 他部署の所有ファイルの編集
- `packages/shared/` の直接編集
- 価格・料金プランに関わる数値の変更（提案は docs/ にドラフトまで）
- 顧客の実データ（個人情報・企業名）をテストフィクスチャに使うこと
- main への直接 push、PR の自動マージ
