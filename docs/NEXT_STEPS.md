# 朝いちばんの作業（所要 20分）

セルフサーブ連携・ステップ実行器・定期実行トリガーは**本番反映済み**です。
Slack はいますぐ使えます。Google だけ、あなたの設定作業が残っています。

## 1. Google 連携を使えるようにする（20分・これだけ必須）

詳細手順は [self-serve-integrations.md](./self-serve-integrations.md) の §1。要点だけ:

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを用意
2. **API を 4 つ有効化**: Google Docs / Sheets / Slides / **Drive**（Drive を忘れると 403）
3. **OAuth 同意画面**: 外部 / アプリ名 / スコープに `.../auth/drive.file` を追加 /
   テストユーザーに自分のメールを登録
4. **OAuth クライアント ID（ウェブアプリ）** を作成し、承認済みリダイレクト URI に:
   ```
   https://org-ai-api-gateway.onrender.com/api/oauth/google/callback
   ```
5. **Render の org-ai-api-gateway に環境変数を 2 つ追加**:
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`

   ※ `API_GATEWAY_URL` は既に設定済みのはず。未設定なら
   `https://org-ai-api-gateway.onrender.com` を追加してください。

設定後、FLOW の **設定 > 連携 > Google** で「Google で接続」。

### 動作確認が済んだら「アプリを公開」を押す
テストモードのままだと **refresh token が 7 日で失効**して毎週再接続が必要になります。
このアプリは `drive.file`（非センシティブ）しか使わないので、**本番公開に Google の審査は不要**です。
押した瞬間に 7 日失効も 100 人制限も消えます。

## 2. Slack 連携（顧客側で完結・10分）

api.slack.com でアプリを作り、Bot Token Scopes に `chat:write` と `chat:write.public` を付けて
インストール → `xoxb-` トークンを FLOW の **設定 > 連携 > Slack** に貼るだけ。
手順は [self-serve-integrations.md](./self-serve-integrations.md) の §3。

## 3. 触って確認してほしいこと

1. **設定 > 連携** — Slack / Google のカードが出ていること
2. **エージェント作成で「定期」を選ぶ** — 頻度・曜日・時刻（日本時間）が出る。
   作った後、一覧に「毎週木曜 09:00 · 次回 …」と表示される
3. **Slack 投稿を含むエージェントを実行** — すぐには送信されず、
   **受信 > エージェント承認** に積まれる。本文を編集して承認すると Slack に届く
4. **チャットで「ドキュメントにして」** — いきなり作らず確認カードが出る → 承認して作成

## 4. 保留にしてある宿題

- **db-keepalive の GitHub Actions を一時停止中**。Supabase の接続文字列（パスワード込み）を
  GitHub Secrets に入れれば復活します:
  ```
  gh secret set DATABASE_URL -R hamada-phasera/org-ai-platform
  ```
  （値は Render の `DATABASE_URL` をコピペ。貼り付けは画面に出ません）
  そのあと `gh workflow enable db-keepalive.yml -R hamada-phasera/org-ai-platform`
- **Gemini API の課金 tier 化**（無料 tier は入力が製品改善に使われるため）
- **Groq の旧 API キー revoke**

## 5. 今回スコープ外（次の候補）

Gmail 送受信 / ワークフローの可視化キャンバス（AI が組む様子を見せる）/
スクショ・URL からのワークフロー再現 / 分単位の定期実行
