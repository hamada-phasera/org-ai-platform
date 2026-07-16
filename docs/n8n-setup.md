# n8n セットアップ手順

org-ai-platform から n8n を利用可能にするための手順。task-executor.ts は
n8n の Webhook トリガーを叩く設計に変更済み。

---

## アーキテクチャ概要

```
API Gateway (Fastify)
  └─ POST /webhook/dept-<dept>     ─→ n8n (Render)
        ├─ Webhook トリガー
        ├─ Build Prompt
        ├─ AI Engine /llm/chat        ─→ ai-engine (Render)
        └─ Callback                   ─→ API Gateway /api/webhooks/n8n/task-complete
```

- `apps/n8n-workflows/dept-*.json` — 各部署のワークフロー (Webhook 起動)
- `apps/n8n-workflows/gen-sales-proposal.json` / `gen-sns-draft.json` — 生成系 dept 操作 (D1)。
  gateway の `dispatchGenerationTask` が `/webhook/sales-proposal` / `/webhook/sns-draft` を叩く。
  gateway が組み立てた `llmBody` をそのまま `/llm/chat` へ転送する WAF-safe 形（Code ノード無し）。
- `apps/n8n-workflows/sns-publish-prep.json` — SNS 投稿準備 cron (D2 段階1・15分毎)。
  gateway `/api/webhooks/n8n/sns-publish-prep` を叩き、APPROVED + scheduledAt 到来の下書きに
  プレビュー生成・キュー投入マークを付ける。**実投稿はしない**。
- `apps/n8n-workflows/analytics-alert.json` — 分析 KPI アラート cron (毎時)。
  gateway `/api/webhooks/n8n/kpi-alert-check` を叩き、閾値超過を RiskEvent に記録する。
- `apps/api-gateway/src/services/task-executor.ts` — Webhook を呼ぶ実装
- フォールバック: Webhook が到達不可なら AI Engine を直接呼ぶ（cron 系は n8n が寝ていれば単に次回実行に持ち越し）

---

## 0. 状態確認

```bash
npm run n8n:status
```

| 表示 | 意味 | 対処 |
|---|---|---|
| `× ネットワーク到達不可` | DNS / Render service 停止 | Render ダッシュボードで Restart |
| `× DB 未接続` | Postgres 切断 | 下記 **DB 復旧** 手順 |
| `× API キー無効` | Key が他テナント由来 / 失効 | 下記 **API キー再発行** |
| `× webhook 404` | ワークフロー未 Activate | `npm run n8n:import` → UI で Activate |

---

## 1. Render Postgres の復旧 (DB 未接続のとき)

Render Free Postgres は **90 日で自動削除** される。削除済み or 別 DB のとき:

1. https://dashboard.render.com → `org-ai-n8n` Service を開く
2. **Environment** タブで以下を確認:
   - `DB_POSTGRESDB_HOST` (例: `dpg-xxx-a.oregon-postgres.render.com`)
   - `DB_POSTGRESDB_DATABASE`
   - `DB_POSTGRESDB_USER`
   - `DB_POSTGRESDB_PASSWORD`
3. **Linked Database** が "Available" であることを確認
4. Available でない場合:
   - Render → New + → PostgreSQL (Free) を作成
   - n8n service の `DB_POSTGRESDB_*` を新しい値に上書き
   - **重要**: `N8N_ENCRYPTION_KEY` が同じであることを確認 (異なると保存済み credential が複合できない)
5. `Manual Deploy → Clear build cache & deploy`

---

## 2. API キー再発行

1. https://org-ai-n8n-web.onrender.com にログイン (owner 認証情報必要)
   - パスワード忘れの場合は Render Shell で n8n を再 init するしかない
2. 右下 ⚙ → **Settings** → **API**
3. **Create an API key** をクリック
4. 表示されたトークンを `.env` の `N8N_API_KEY=` に貼り付け
5. `npm run n8n:status` で `✓ API キー有効` を確認

---

## 3. ワークフローのインポート

```bash
npm run n8n:import
```

出力例:
```
[create] org-ai Dept Sales
  active=true
[create] org-ai Dept Marketing
  active=true
...
```

すでに同名のワークフローがある場合は `[update]` で上書きされる。

---

## 4. Webhook 認証

`npm run n8n:import` が **自動で**:
1. `httpHeaderAuth` credential (name: `org-ai webhook token`, header: `x-org-ai-token`, value: `$N8N_WEBHOOK_AUTH_TOKEN`) を作成
2. 全 Webhook ノードにこの credential を紐付け
3. ワークフローを activate

までを実行する。手動 UI 作業は不要。

> **手動でやる場合** (Public API がない n8n バージョン等):
> 1. 左メニュー **Credentials** → **New** → **Header Auth**
> 2. Name: `org-ai webhook token` / Header Name: `x-org-ai-token` / Value: `$N8N_WEBHOOK_AUTH_TOKEN`
> 3. 各ワークフローの Webhook ノードでこの credential を選択 → Save → Activate

---

## 5. 動作確認

### 5a. webhook 単体テスト
```bash
curl -X POST https://org-ai-n8n-web.onrender.com/webhook/dept-general \
  -H "Content-Type: application/json" \
  -H "x-org-ai-token: org-ai-n8n-secret-token" \
  -d '{
    "taskId":"smoke-1",
    "orgId":"<your-org-id>",
    "title":"テスト",
    "input":"こんにちは",
    "department":"GENERAL",
    "plan":"STARTER",
    "callbackUrl":"http://localhost:4000/api/webhooks/n8n/task-complete",
    "logUrl":"http://localhost:4000/api/webhooks/n8n/task-log",
    "aiEngineUrl":"http://localhost:8000"
  }'
```

期待される応答: 即座に `200 {}` (responseMode は onReceived)。
n8n UI の Executions タブで該当実行のログを確認できる。

### 5b. ステータス再確認
```bash
npm run n8n:status
```
全項目 `✓` になれば完了。

### 5c. アプリ統合テスト
1. `./scripts/start-dev.sh` で gateway/ai-engine/web を起動
2. ブラウザで `/chat/sales` → タスクを発行
3. Tasks 画面で `n8nWorkflowId` が記録されていることを確認
4. n8n UI の Executions に該当実行が現れることを確認

---

## トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| webhook → 404 "The webhook is not registered" | ワークフローが inactive | UI でトグル Activate |
| webhook → 403 "Authorization data is wrong!" | Header Auth credential 未割当 / 値ミス | 手順 4 をやり直す |
| 実行は成功するが callbackUrl にデータが来ない | API Gateway 側 `N8N_WEBHOOK_AUTH_TOKEN` がワークフローの値と不一致 | `.env` を合わせて gateway 再起動 |
| Workflow 編集→Save できない (Public API キー消える) | Render free plan の cold start で credential cache がクリア | 起き続けたら Standard plan に上げる |
| AI Engine Chat ノードが 503 | `aiEngineUrl` が Docker 内部 URL のまま | runData 送信時に `https://org-ai-ai-engine.onrender.com` を明示する |

---

## ローカル開発で n8n を完全に使わない場合

`.env` から `N8N_CLOUD_URL` と `N8N_URL` を削除 (もしくは `N8N_API_KEY` を空に) すれば、
task-executor は AI Engine の `/orchestrate` 直叩きにフォールバックする。
n8n に依存しない最小スタックで動作する。
