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
| その他すべて | 300 回 / 分 |
| `/api/webhooks/stripe`・`/api/webhooks/line`・`/health` | 制限なし（署名で守られている / 死活監視） |

- 超えると 429 `{ success: false, error: { code: 'RATE_LIMITED', message } }` と `Retry-After`。
- IP は `X-Forwarded-For` から取る。`TRUST_PROXY_HOPS`（既定 1 = Render のロードバランサ）段だけを信じる。
  ⚠️ 実際より多くすると、利用者がヘッダを書いて制限をすり抜けられる。直接公開するなら 0。
- 保持はプロセスのメモリ。再起動で数え直し。gateway を複数台にするときは Redis 等の store に替える（D8）。
- 全員が 429 になる場合は、プロキシの段数がずれて全員が同じ IP に見えている可能性が高い。ログの `[rate-limit]` の `ip=` を確認する。

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

- 操作の後に書くものは、記録に失敗しても操作は成功させる（ログに `[audit]`）。
- `meta` は名前が秘密らしいキー（token / secret / password / key / authorization など）の値を `[REDACTED]` にし、文字列は 200 文字で切る。
  呼び出し側も生トークン・暗号文を渡さない（テストで固定）。
- 閲覧は管理者以上。操作者の名前はその組織の所属から引く。

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
