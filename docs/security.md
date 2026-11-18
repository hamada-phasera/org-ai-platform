# セキュリティの運用メモ（api-gateway）

計画書 `docs/plan/saas-readiness-plan.md` チャンク 7 で入れたもの。

| 項目 | 場所 |
|---|---|
| レート制限 | `apps/api-gateway/src/middleware/rate-limit.ts` |
| 起動拒否 | `apps/api-gateway/src/config/startup-checks.ts` |
| 監査記録 | `apps/api-gateway/src/services/audit.ts`、閲覧 `GET /api/governance/audit` |
| メールの正規化 | `apps/api-gateway/src/utils/email.ts` |
| `/ready` | `apps/api-gateway/src/routes/health.ts` |

## レート制限

| 対象 | 上限（IP ごと） |
|---|---|
| `POST /api/auth/login`・`POST /api/auth/register` | 10 回 / 分 |
| 招待のプレビュー・受諾（`/api/members/invitations/preview/:token`・`accept`・`accept-existing`） | 20 回 / 分 |
| 業務ページの登録（n8n。`/api/webhooks/n8n/pages`。登録トークンの当てずっぽう対策） | 20 回 / 分 |
| 業務ページのデータ取得・送信（`/api/pages/:slug/data/*`・`/api/pages/:slug/actions/*`）。別に**組織ごと**に取得 120・送信 30 回 / 分（`services/pages/org-throttle.ts`） | 60 回 / 分 |
| その他すべて | 300 回 / 分 |
| `/api/webhooks/stripe`・`/api/webhooks/line`・`/health` | 制限なし（署名で守られている / 死活監視） |

- 超えると 429 `{ success: false, error: { code: 'RATE_LIMITED', message } }` と `Retry-After`。
- IP は `X-Forwarded-For` から取る。`TRUST_PROXY_HOPS`（既定 1 = Render のロードバランサ）段だけを信じる。
  ⚠️ 実際より多くすると、利用者がヘッダを書いて制限をすり抜けられる。直接公開するなら 0。
- 保持はプロセスのメモリ。再起動で数え直し。gateway を複数台にするときは Redis 等の store に替える（D8）。
  業務ページの組織ごとの窓（`org-throttle.ts`）も同じくメモリなので、複数台にするときは一緒に替える（custom-pages T18）。
- 全員が 429 になる場合は、プロキシの段数がずれて全員が同じ IP に見えている可能性が高い。ログの `[rate-limit]` の `ip=` を確認する。
  デプロイ直後の確認手順（2 回線から叩いて `ip=` を比べる）は `docs/DEPLOY.md` 6 章の 6。

## 起動拒否

`NODE_ENV=production` で `N8N_WEBHOOK_AUTH_TOKEN` が未設定・空・既定値（リポジトリに載っている値）なら gateway は起動しない。
`JWT_SECRET` が 32 文字未満なら環境を問わず起動しない。

`INTERNAL_API_TOKEN` 未設定と `GEMINI_PAID_TIER` が true でないことは**止めずに**、設定 > 基本 の「セットアップ状況」に「要対応」で出す。

## 監査記録（AuditEvent）

| action | いつ |
|---|---|
| `org.create` | 登録・組織の作成（同じトランザクション） |
| `org.update` | 組織名・請求先メールの変更 |
| `member.invite` / `member.invite_revoke` | 招待の発行・取り消し |
| `member.join` | 招待の受諾（同じトランザクション） |
| `member.role_change` / `member.status_change` | 役割変更・無効化と復帰 |
| `billing.checkout_start` / `billing.plan_change` / `billing.storage_addon` | Checkout 開始・プラン変更・追加容量 |
| `integration.connect` / `integration.disconnect` | Slack・Google・LINE の接続と切断 |
| `page.upsert` / `page.delete` / `page.publish` / `page.unpublish` | 業務ページの登録・削除・公開（n8n 経由は `actorId` が null、`meta.registrarId` に登録トークンの id） |
| `page_token.issue` / `page_token.revoke` | ページ登録トークンの発行・失効 |

- 操作の後に書くものは、記録に失敗しても操作は成功させる（ログに `[audit]`）。
- `meta` は名前が秘密らしいキー（token / secret / password / key / authorization など）の値を `[REDACTED]` にし、文字列は 200 文字で切る。
  呼び出し側も生トークン・暗号文を渡さない（テストで固定）。
- 閲覧は管理者以上。操作者の名前はその組織の所属から引く。

## 業務ページ（n8n 連携）

設計は `docs/design/custom-pages.md` §10、構築の手順は `docs/custom-pages-n8n.md`。

| 守り | 中身 |
|---|---|
| 届く先 | gateway が `${N8N の URL}/webhook/pages/<JWT の orgId>/<hook>` に組み立てる。定義に書けるのは `hook`（英小文字・数字・ハイフン）だけ＝他組織・既存の `dept-*` `cap-*` `agent-*` には構造的に届かない。リダイレクトは追わない |
| 登録 | 組織ごとの登録トークン（`x-page-token`、`flowpg_…`）。DB はハッシュと先頭 10 文字だけ、生値は発行時に 1 回だけ表示、失効は即時、有効は 2 本まで。共有トークン（`x-webhook-token`）では登録できない |
| 描画 | 許可リストの 7 ブロックだけ、`.strict()`、テキストノードだけで描く（`dangerouslySetInnerHTML`・リンク・画像・スタイルは定義から来ない）。n8n の応答は宣言した key とスカラーに切り詰めてから web に渡す |
| 応答 | `hook`・トークンのハッシュ・n8n の URL とエラー本文は利用者に返さない。ログにも入力値・応答本文を出さない |
| 記録 | `PageActionLog` は送信ごとに項目名だけ（値は持たない） |
| サンプルモード | `PAGES_SAMPLE_MODE=true` は本番（`NODE_ENV=production`）では常に無効。`sampleData` は seed だけが書ける |
| 外部送信 | ページのアクションは JWT のルートからしか呼べない（エージェント・定期実行からは呼べない）。外へ送るアクションには `confirm` を書く規約 |

## メールの小文字化

登録・ログイン・招待のメールは前後の空白を除いて小文字にしてから保存・照合する。
既存行はマイグレーション `20261120000200_add_audit_event_and_email_lowercase` が小文字にするが、
**小文字にすると別の行と同じになる行は触らない**（一意制約で migrate が落ちるのを避けるため）。
触らなかった行の人は小文字のメールでログインできないので、**デプロイ前に**件数を数える:

```sql
SELECT lower(trim(email)) AS normalized, count(*) AS n, array_agg(id) AS user_ids
FROM "User"
GROUP BY lower(trim(email))
HAVING count(*) > 1;
```

0 行でなければ、どちらの行を残すかをオーナーが決めて整理する（所属・作成物の付け替えを伴うので自動ではやらない）。
