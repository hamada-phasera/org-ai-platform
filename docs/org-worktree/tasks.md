# org-ai-platform 部署別タスク表

> 配置先: リポジトリの `docs/tasks.md`（main にコミットして全 worktree から見えるようにする）
> 各エージェントは自分のセクションのみ更新可。他部署のセクションは読むだけ。
> タスク完了時はチェックを入れ、同じコミットで成果物のパスを追記する。

## 📋 進捗ボード（3画面体制 — オーガナイザーのみ「割当」欄を編集可）

| 部署 | ブランチ | 割当画面 | 状態 | PR |
|------|---------|---------|------|-----|
| 営業 | feat/sales-dept | 画面2 | 🔵 作業中 | — |
| 分析 | feat/analytics-dept | 画面3 | 🔵 作業中 | — |
| SNS | feat/sns-dept | （待機列） | ⚪ 未着手 | — |
| 統合 | feat/integration | 画面1 | ⚪ 全部署完了後 | — |

状態: ⚪ 未着手 / 🔵 作業中 / 🟡 ブロック中 / ✅ 完了・PR済み

> ワーカーは自分の行の「状態」「PR」のみ更新可。「割当画面」はオーガナイザーが決める。
> 部署が完了したら、空いた画面に待機列の部署をオーガナイザーが割り当てる。

## 運用ルール

- タスク粒度: 1タスク = 1〜3コミットで終わる大きさに分解する
- 依存があるタスクには `⛓ depends:` を明記（他部署依存の場合は待たずにモックで先行）
- 共有型の変更が必要になったら、ここではなく `docs/integration-requests.md` に書く

---

## 🏷 営業部署（feat/sales-dept）

<!-- TODO: 実際のタスクに置き換え。以下は形式のサンプル -->
- [ ] S-1: リード一覧画面の実装（`apps/sales/`）
- [ ] S-2: 商談パイプラインのAPIルート（`packages/api/src/routes/sales/`）
- [ ] S-3: 提案書ドラフト生成機能 ⛓ depends: 共有プロンプトテンプレート型（integration-requests #1）
- [ ] S-4: S-1〜S-3 のテスト整備（カバレッジ80%以上）

## 📊 分析部署（feat/analytics-dept）

- [ ] A-1: イベントスキーマ v1 の提案（→ integration-requests.md へ）
- [ ] A-2: usage-metrics-svc の集計エンドポイント追加
- [ ] A-3: KPIダッシュボード画面（`apps/analytics/`）
- [ ] A-4: `tests/business/` にイベント発火テスト追加

## 📣 SNS投稿部署（feat/sns-dept）

- [ ] N-1: 投稿下書き生成（プラットフォーム別フォーマット: Instagram / X）
- [ ] N-2: 承認待ちキュー UI（自動投稿は実装しない — 承認フロー必須）
- [ ] N-3: コンテンツカレンダー画面
- [ ] N-4: 文字数制限・ハッシュタグ整形のエッジケーステスト

## 🔗 統合フェーズ（feat/integration — 3部署のPRが揃ってから）

- [ ] I-1: 横断整合性レビュー（→ `docs/integration-review.md`）
- [ ] I-2: integration-requests.md の消化・shared 昇格
- [ ] I-3: マージ順序の決定と rebase 指示
- [ ] I-4: マージ後の統合テスト実行

---

# docs/integration-requests.md（別ファイルとして作成）

以下の形式で各部署が追記する:

```markdown
## #1 [営業] 提案書テンプレート型の共有化
- 要求日: 2026-07-XX
- 内容: `ProposalTemplate` 型を packages/shared/types に追加してほしい
- 理由: 営業とSNSの両方でコンテンツ生成に使うため
- 暫定対応: apps/sales/ 内にローカル型でモック中
- ステータス: 未対応 / 対応中 / 完了
```
