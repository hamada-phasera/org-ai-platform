# セルフサーブ連携（Slack / Google）セットアップ手順

顧客が **設定 > 連携** から自分で接続するための連携。トークンは FLOW の DB に
暗号化（AES-256-GCM）して保存し、gateway が直接 Slack / Google API を叩く。
n8n の credential には依存しない（= 顧客が増えても n8n 側の手作業はゼロ）。

対象 capability:

| capability | provider | 接続方法 |
|---|---|---|
| notify_slack（Slack 投稿） | slack | Bot トークン貼付 |
| create_google_doc（ドキュメント作成） | google | OAuth |
| create_google_sheet（スプレッドシート作成） | google | OAuth |
| create_google_slides（スライド作成） | google | OAuth |

**まだ n8n 側管理のまま**: send_email(gmail) / post_to_x(x) / summarize_sheet(google_sheets)。
これらは `docs/oauth-setup.md` の従来手順が有効。

---

## 1. 運営（あなた）の一度きりの作業 — GCP OAuth クライアント（15〜20分）

Google 連携は「FLOW というアプリ」として 1 つ OAuth クライアントを作り、
顧客はそれに対して自分の Google アカウントで同意する形。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成（既存でも可）
2. **API とサービス > ライブラリ** で 4 つ有効化:
   - Google Docs API
   - Google Sheets API
   - Google Slides API
   - **Google Drive API**（drive.file スコープの土台。忘れると 403 になる）
3. **OAuth 同意画面**:
   - User Type: **外部**
   - アプリ名 / サポートメール / デベロッパー連絡先を入力
   - スコープを追加: `https://www.googleapis.com/auth/drive.file`
     （`openid` と `email` は既定で付く）
   - 公開ステータス: **テスト**（後述のとおり早めに「本番」へ切り替えを推奨）
   - **テストユーザー**に、接続させたい Google アカウント（自分＋顧客）を追加。最大 100 件
4. **認証情報 > OAuth クライアント ID を作成**:
   - 種類: **ウェブアプリケーション**
   - 承認済みのリダイレクト URI に次の 2 つを登録:
     - `https://org-ai-api-gateway.onrender.com/api/oauth/google/callback`
     - `http://localhost:4000/api/oauth/google/callback`（ローカル開発用）
   - 発行された **クライアント ID / クライアントシークレット**を控える
5. **Render の api-gateway に環境変数を設定**（Dashboard > Environment）:
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `API_GATEWAY_URL` = `https://org-ai-api-gateway.onrender.com`
     （リダイレクト URI の組み立てに使う。未設定だと localhost になり接続できない）

### ⚠️ テストモードの制約と、本番公開の推奨

- テストモードでは **refresh token が 7 日で失効**する。顧客は毎週「再接続」が必要になる
  （FLOW 上は「再接続が必要」と表示され、ボタン 1 つで復旧はする）
- テストユーザーは 100 件まで
- **本設計は drive.file（非センシティブスコープ）だけを使うため、公開ステータスを
  「本番」に切り替えても Google の審査は不要**。切り替えた瞬間に 7 日失効も 100 人制限も消える
- → 動作確認が済んだら早めに「アプリを公開」を押すのがおすすめ

---

## 2. 顧客の作業 — Google（2分）

1. （テストモードの間だけ）使う Google アカウントのメールアドレスを運営に伝え、
   テストユーザーに登録してもらう
2. FLOW の **設定 > 連携 > Google** で「Google で接続」
3. 同意画面で許可（テストモード中は「このアプリは確認されていません」警告が出る →
   「詳細」→「（アプリ名）に移動」で続行）
4. FLOW に戻り「接続済み」とアカウントのメールが表示されれば完了

このアプリが触れるのは **FLOW が作成したファイルだけ**（drive.file）。
顧客の既存ドライブの中身は読めない。

## 3. 顧客の作業 — Slack（10分）

1. https://api.slack.com/apps → **Create New App** → From scratch → 自社ワークスペースを選択
2. 左メニュー **OAuth & Permissions** → Scopes → **Bot Token Scopes** に追加:
   - `chat:write`（必須）
   - `chat:write.public`（推奨。ボット未参加の公開チャンネルにも投稿できる）
3. 同ページ上部の **Install to Workspace** → 許可
4. **Bot User OAuth Token**（`xoxb-` で始まる）をコピー
5. FLOW の **設定 > 連携 > Slack** に貼り付けて「接続する」
6. 非公開チャンネルに投稿したい場合のみ、そのチャンネルで `/invite @アプリ名`

`chat:write` が無いトークンは接続時に弾かれる。`chat:write.public` が無い場合は
接続はできるが「招待していないチャンネルには投稿できない」旨の警告が出る。

---

## 4. 動作確認

1. 設定 > 連携 で Slack / Google が「接続済み」になっている
2. チャットで何か回答を出させ、成果物バーの「ドキュメント」を押す
   → 確認カード（何を・どんな内容で作るか）が出る → 承認 → URL が返る
3. Slack 投稿を含むエージェントを実行 → **受信 > エージェント承認**に積まれる
   → 本文を確認・編集して承認 → Slack に届く

## 5. トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| 「Google の接続または再接続が必要です」 | テストモードの 7 日失効、または顧客が許可を取り消した。設定 > 連携 から再接続。本番公開に切り替えれば失効しない |
| 接続直後に「接続に失敗しました」 | `GOOGLE_OAUTH_CLIENT_ID/SECRET` 未設定、または GCP のリダイレクト URI が `API_GATEWAY_URL` と一致していない |
| Slack で `channel_not_found` | チャンネル名の綴り違い、または非公開チャンネルに未招待（`/invite`） |
| Slack で「chat:write スコープがありません」 | Bot Token Scopes に追加後、**再インストール**が必要（スコープ追加だけでは既存トークンに反映されない） |
| capability が NEEDS_AUTH のまま | 接続は org 単位。別の組織アカウントでログインしていないか確認 |

## 6. セキュリティ上の約束

- トークンは AES-256-GCM で暗号化して保存し、**API レスポンスにも画面にもログにも出さない**
- 暗号鍵は `CHANNEL_CREDENTIAL_ENC_KEY`（未設定時は `JWT_SECRET` から導出）。
  この鍵をローテすると既存の接続は復号できなくなり、再接続が必要になる
- OAuth の `state` は有効期限 10 分の署名付き JWT。組織 ID は state からのみ取得する
- コールバック後のリダイレクト先は `FRONTEND_URL` 固定（オープンリダイレクトなし）
- Google のスコープは最小（drive.file）。既存ファイルの読み取り権限は要求しない
