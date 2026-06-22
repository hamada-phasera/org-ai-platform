# 外部連携 OAuth セットアップ（Google Workspace / Slack）

チャットで要件が固まると、AI が **Googleドキュメント / スプレッドシート / スライド / Slack投稿** を成果物として作れます（capability `create_google_doc` / `create_google_sheet` / `create_google_slides` / `notify_slack`）。
これらは n8n のワークフロー経由で実行され、**各サービスの OAuth 接続を n8n に 1 回だけ登録**すれば有効になります。接続するまでは capability は `NEEDS_AUTH`（チャットでは「接続が必要です」と案内）になります。

- n8n: `https://org-ai-n8n-web.onrender.com`
- 実行の仕組み: gateway `POST /api/capabilities/resolve` → n8n `POST /webhook/cap-<name>`（Header Auth `x-org-ai-token`）→ provider ノード → 標準エンベロープ `{status,error_type,message,data}` を返す。

---

## 0. ワークフローの取り込み（最初に 1 回）

リポジトリの `apps/n8n-workflows/cap-*.json` を n8n に取り込みます。

```bash
# .env に N8N_CLOUD_URL / N8N_API_KEY / N8N_WEBHOOK_AUTH_TOKEN が入っている前提
node scripts/n8n-import-workflows.mjs
```

これで `org-ai Cap create_google_doc` などが作成・アクティブ化され、Webhook ノードに Header Auth クレデンシャル（`x-org-ai-token`）が自動で紐づきます。**provider（Google/Slack）の OAuth は次章で手動接続**します。

---

## 1. Google Workspace（Docs / Sheets / Slides）

### 1-1. Google Cloud 側
1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成（既存でも可）。
2. 「API とサービス」→「ライブラリ」で以下を **有効化**:
   - Google Docs API / Google Sheets API / Google Slides API / Google Drive API
3. 「OAuth 同意画面」を構成（External → アプリ名・サポートメール。テスト中は自分のアカウントを「テストユーザー」に追加）。
4. 「認証情報」→「認証情報を作成」→「OAuth クライアント ID」→ アプリの種類「ウェブ アプリケーション」。
5. **承認済みリダイレクト URI** に n8n のコールバックを登録:
   ```
   https://org-ai-n8n-web.onrender.com/rest/oauth2-credential/callback
   ```
6. 作成された **クライアント ID / クライアント シークレット** を控える。

### 1-2. n8n 側（Docs / Sheets / Slides それぞれ）
1. n8n → 左下 **Credentials** → **Add credential**。
2. 種類を検索して選択:
   - `Google Docs OAuth2 API`（名前は **`Google Docs OAuth2`** にする）
   - `Google Sheets OAuth2 API`（名前 **`Google Sheets OAuth2`**）
   - `Google Slides OAuth2 API`（名前 **`Google Slides OAuth2`**）
3. それぞれに 1-1 のクライアント ID / シークレットを入力し、**「Connect my account」**で Google にサインイン・許可。
4. 取り込んだ各ワークフロー（`org-ai Cap create_google_doc` 等）を開き、provider ノード（Create Google Doc / Sheet / Slides、Insert Content）の **Credential** に上で作成したものを選択 → **Save** → 右上 **Active** を ON。

> 名前は任意ですが、capability 側の provider 文字列（`googledocs` / `googlesheets` / `googleslides`）が n8n のクレデンシャル **type** に部分一致するため、type が一致していれば自動で「接続済み」と判定されます。

---

## 2. Slack（notify_slack）

### 2-1. Slack 側
1. [Slack API: Your Apps](https://api.slack.com/apps) → **Create New App** → From scratch。ワークスペースを選択。
2. **OAuth & Permissions** → **Scopes → Bot Token Scopes** に追加:
   - `chat:write`（投稿）
   - 必要に応じ `channels:read` / `chat:write.public`（公開チャンネルへ Bot 未参加でも投稿）
3. **Install to Workspace** で許可し、**Bot User OAuth Token（`xoxb-...`）** を控える。
4. 投稿先チャンネルに Bot を招待（`/invite @アプリ名`）。

### 2-2. n8n 側
1. Credentials → Add credential → **`Slack API`**（名前 **`Slack API`**）。
2. **Access Token** に `xoxb-...` を入力 → Save。
3. `org-ai Cap notify_slack` ワークフローを開き、Post to Slack ノードの Credential を選択 → Save → Active ON。

---

## 3. 接続確認

### capability の状態確認（gateway 経由）
ログイン済みの JWT を使って:
```bash
curl -s https://<gateway>/api/capabilities -H "Authorization: Bearer $JWT" | jq '.data[] | {name, status, requiredCreds}'
```
OAuth 接続済みなら `requiredCreds[].status` が `CONNECTED` になり、resolve 時に実行されます（未接続なら `NEEDS_AUTH`）。

### webhook 直叩き（n8n 単体テスト）
```bash
curl -X POST https://org-ai-n8n-web.onrender.com/webhook/cap-create_google_doc \
  -H "Content-Type: application/json" \
  -H "x-org-ai-token: $N8N_WEBHOOK_AUTH_TOKEN" \
  -d '{"title":"テスト議事録","content":"# 議題\n- 動作確認"}'
# → {"status":"success","data":{"documentId":"...","url":"https://docs.google.com/document/d/.../edit"}}
```

### チャットからの動作（本番想定）
チャットで要件を詰める → 成果物 CTA（「📄 ドキュメント作成」等）→ `POST /api/capabilities/resolve`（name + 会話由来の args）→ n8n 実行 → ドキュメント URL が返る。

---

## 4. 注意・トラブルシュート
- **ノードのパラメータ確認**: 各 `cap-*.json` は実績パターンを基にしたテンプレートです。お使いの n8n バージョンで provider ノードの操作名/項目が異なる場合は、エディタ上でひと目だけ確認・調整してください（特に Docs の本文挿入、Sheets の行マッピング、Slides の本文）。
- **WAF**: Render は Cloudflare WAF 配下。Public API での取り込みは Set/Code いずれも通ることを確認済みですが、特定の jsCode が 403 になる場合は UI から JSON を取り込んでください。各 cap はエンベロープを式（respondToWebhook）で生成し Code ノードを使っていません。
- **トークン失効**: OAuth トークンが切れると実行が `NODE_FAILED` になります。n8n でクレデンシャルを再接続してください。`GET /api/capabilities/execution-logs` で失敗を確認できます。
