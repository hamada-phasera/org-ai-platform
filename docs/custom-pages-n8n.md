# 業務ページを n8n で作る（構築者向けの手順）

組織ごとの業務ページ（`/p/:slug`）を、n8n のワークフローで登録し、データと送信を n8n で動かす手順。
設計は [docs/design/custom-pages.md](design/custom-pages.md)。サンプルは `apps/n8n-workflows/pages/page-inquiries.json`。

> ⚠️ サンプルは `npm run n8n:import` では入らない（組織 ID を置き換えてから手で入れる。そのまま入れると全組織共通の Webhook ができてしまう）。

## 1. 前提（運営が 1 回だけ）

| # | 内容 |
|---|---|
| 1 | gateway に `N8N_CLOUD_URL`（または `N8N_URL`）と `N8N_WEBHOOK_AUTH_TOKEN` が入っている（既存の連携と同じ値。追加の環境変数は不要） |
| 2 | n8n に Header Auth credential `org-ai webhook token`（ヘッダ名 `x-org-ai-token`、値 = `N8N_WEBHOOK_AUTH_TOKEN`）がある（`npm run n8n:import` が作る） |
| 3 | n8n の環境変数 `FLOW_GATEWAY_URL` に gateway の URL（例 `https://<gateway のホスト>`。末尾の `/` なし） |
| 4 | n8n が複数階層の Webhook パス（`pages/<orgId>/<hook>`）を受けることを 1 回確かめる（設計書 U2 / Q1） |

`$env` を読めない設定（`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`）の n8n では、登録ノードの URL に gateway の URL を直接書く。

## 2. 顧客ごとの手順

| # | どこで | 作業 |
|---|---|---|
| 1 | FLOW 設定 > 業務ページ（オーナー・パソコン） | 「組織ID」を控える。登録トークンを発行し、表示された値をコピーする（**この 1 回しか出ない**） |
| 2 | n8n Credentials | Header Auth を新規作成。名前 `FLOW page token`、ヘッダ名 `x-page-token`、値 = 1 のトークン |
| 3 | サンプル JSON | `__ORG_ID__` をすべて 1 の組織 ID に置き換える（ワークフロー名・Webhook のパス・webhookId・IF の比較値） |
| 4 | n8n | 置き換えた JSON を取り込み、Webhook ノード 2 つの credential に `org-ai webhook token`、登録ノードに `FLOW page token` を選ぶ。**Activate** |
| 5 | n8n | 「登録を実行」を手動で実行。応答の `data.url` が出れば成功（既定は下書き） |
| 6 | FLOW 設定 > 業務ページ | 下書きで現れたページを「公開」。メンバーのナビ（業務）に出る |

何度「登録を実行」しても結果は同じ（定義が同じなら `changed: false`）。画面で変えた公開・並び・表示する役割は、
登録の body に書かない限り戻らない。

## 3. 決まり（必ず守る）

| 決まり | 理由 |
|---|---|
| Webhook のパスは `pages/<その組織の ID>/<hook>`。`hook` は英小文字・数字・ハイフンだけ | gateway がこの形でしか呼ばない（他組織や既存ワークフローには届かない） |
| Webhook は必ず Header Auth（`org-ai webhook token`）。最初のノードで `body.orgId` を確かめ、違えば 403 | 共有トークンが漏れたときの被害を組織で止める |
| 登録には登録トークン（`x-page-token`）だけを使う。body に `orgId` は書かない | 組織はトークンが決める |
| LLM を使うなら `body.aiEngineUrl` の `/llm/chat` に `org_id` と `plan` を渡す。プロバイダを直接呼ばない | AILog・PII 検知・月間上限を通す |
| メール・Slack・LINE など外へ送るアクションには定義に `confirm` を書く | 人が確かめてから送る（設計書 K10） |
| 応答は 10 秒以内・256KB 以内・JSON。重い処理は受け付けだけ返し、別のワークフローに回す | 超えると利用者には「取得できませんでした」 |
| 入力値・応答本文をログや外部に残さない（必要なものだけ保存先に） | 個人情報を溜めない |

## 4. gateway が送るもの・受け取るもの

Webhook の body（POST）:

```json
{ "orgId": "…", "page": "inquiries", "action": "create", "kind": "submit",
  "input": { "name": "…", "subject": "…" },
  "actor": { "userId": "…", "role": "MEMBER" }, "plan": "PRO", "requestId": "…", "aiEngineUrl": "…" }
```

- `input` は定義どおりに検証済み（知らない項目・型違い・長すぎる値は gateway が 400 で止め、n8n には届かない）。
  表の行の操作は `{ rowId }`、ボタンは `{}`。メールアドレスや氏名は送らない。

応答（query = データ取得）: 定義の `source.key` に合わせたオブジェクト。

| ブロック | 応答の形 | 注意 |
|---|---|---|
| `kpi` | `{ "<key>": 数値か 32 文字以下の文字列か null }` | `percent` は**百分率の数**（12.5 → 12.5%）。0〜1 の比率は 100 倍してから返す |
| `table` | `{ "<key>": [ { "<列の key>": 値, … } ] }` | セルは文字列・数値・真偽・null だけ（入れ子は落ちる）。200 行・200 文字で切る。`rowKey` が無い行には行の操作が出ない |
| `list` | `{ "<key>": [ { titleKey, subKey, metaKey } ] }` | 100 行まで |

宣言していない key・列は gateway が捨てる。形が違うブロックだけ「表示できません」になり、他のブロックは出る。

応答（submit = 送信）: `{ "ok": true, "message": "登録しました" }`（`message` は 140 文字まで、他の項目は捨てる）。
業務上の失敗は `{ "ok": false, "message": "…" }` で返すと、利用者にその文言が出る。

## 5. 上限と数え方

- 数えるのは送信（フォーム・ボタン・行の操作）だけ。n8n まで届いたものは失敗も 1 回（設計書 K35）。データ取得は数えない。
- 上限はプランごと（ページ数・月間の送信数。`PAGE_LIMITS`）。超えたら送信だけ止まり、表示は続く。

## 6. うまくいかないとき

| 症状 | 見るところ |
|---|---|
| 登録が 401 | `x-page-token` の値・失効していないか（設定 > 業務ページ の最終使用） |
| 登録が 400 `VALIDATION_ERROR` | 応答の message に「場所: 理由」が最大 3 件出る。ブロックの種類・項目名・文字数（ラベルは 8 文字まで） |
| 登録が 403 `PAGE_LIMIT_REACHED` | プランのページ数の上限 |
| 登録が 409 `PAGE_SOURCE_CONFLICT` | 同じ slug を人（管理者の手動更新・seed）が作っている。slug を替えるか、画面で消す |
| 登録が 402 | 組織の契約が切れている（閲覧のみ） |
| ページに「未接続」 | gateway に n8n の URL が入っていない |
| 「取得できませんでした」 | Webhook が Activate されていない・パスの組織 ID 違い・10 秒超え・JSON 以外を返している |
| 「表示できません」 | 応答の key・型が定義と合っていない（gateway のログに `[pages]` の warn が 1 行出る） |

トークンの入れ替え: 新しいトークンを発行 → n8n の `FLOW page token` を差し替え → 古いトークンを失効（有効は 2 本まで）。

## 7. n8n 無しで画面を確かめる（開発用）

`npm run seed --workspace=packages/db-schema` がデモ組織に「問い合わせ」（`/p/inquiries`、公開済み）を入れる。
gateway を `PAGES_SAMPLE_MODE=true` で起動すると、n8n を呼ばずに seed の `sampleData` を本番と同じ検証に通して返す
（送信は「サンプルのため送信していません」。記録も数えもしない）。本番（`NODE_ENV=production`）では常に無効。
定義の正本は `packages/db-schema/prisma/seed-pages.ts`。サンプル JSON の登録ノードの body と一致することをテストで確かめている。
