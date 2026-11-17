# デプロイ手順（本番）

**デプロイの手順はこのファイルだけ**（`DEPLOYMENT_RUNBOOK.md` はここへの案内）。設定はリポジトリ側が正で、
ダッシュボードはこの表に合わせる。食い違いは `npm run check:deploy`（`npm test` にも含む）が検出する。
ローカルで動かすだけなら README の「最短で動かす」（`docker compose up --build`）。

| 部品 | 置き場所 | 正本 |
|---|---|---|
| web（Vite SPA） | Vercel | `vercel.json` |
| api-gateway（Fastify） | Render `org-ai-api-gateway` | `render.yaml` |
| ai-engine（FastAPI） | Render `org-ai-ai-engine` | `render.yaml` |
| n8n（任意） | Render `org-ai-n8n-web` | `render.yaml`（落ちていても ai-engine にフォールバック。O-12） |
| DB | Supabase Postgres（us-west-2）＋ pgvector | `packages/db-schema/prisma/` |
| ファイル | Supabase Storage の非公開バケット `org-files` | `docs/supabase-migration.md` |
| 決済 | Stripe | `docs/billing.md` |

Node は 22（`.node-version`・`engines`・Dockerfile・`NODE_VERSION`・CI）。Python は 3.11。

---

## 1. 秘密の値を用意する

値はパスワードマネージャに置き、リポジトリ・チャット・ログに貼らない。git の履歴に載ったことのある鍵は作り直してから使う。

| キー | 作り方 | 入れる先 |
|---|---|---|
| `JWT_SECRET` | `openssl rand -hex 32`（32 文字以上。リポジトリに載っている見本の値だと本番の gateway は起動しない） | gateway |
| `INTERNAL_API_TOKEN` | `openssl rand -hex 32` | gateway と ai-engine に**同じ値** |
| `N8N_WEBHOOK_AUTH_TOKEN` | `openssl rand -hex 32`（未設定・既定値だと本番の gateway は起動しない） | gateway（n8n を使うなら n8n の Header Auth にも） |
| `CHANNEL_CREDENTIAL_ENC_KEY` | `openssl rand -hex 32`（`JWT_SECRET` から独立させる。変えると LINE・Slack の接続が復号できなくなる） | gateway |
| `ANTHROPIC_API_KEY` | console.anthropic.com | ai-engine |
| `GEMINI_API_KEY` | aistudio.google.com（無料枠は入力が Google の製品改善に使われる。有償の顧客の前に有料へ切り替えて `GEMINI_PAID_TIER=true`。O-11） | ai-engine、gateway（埋め込み） |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API（RLS を貫通する。gateway だけに置く） | gateway |
| Stripe の鍵と price | 3 章 | gateway |

## 2. DB（Supabase）

1. 接続文字列は **Session pooler（`aws-<n>-<region>.pooler.supabase.com:5432`）1 本**に `?sslmode=require` を付けて使う。gateway・ai-engine・n8n とも同じ。
   - direct（`db.<ref>.supabase.co`）は IPv6 のみで Render から届かない（`P1001`）
   - transaction pooler（6543）は Prisma のマイグレーションの advisory lock が保てない
2. `vector` 拡張を Supabase の画面から有効にしない（マイグレーションが作る）。n8n は専用スキーマ `n8n`。詳細は `docs/supabase-migration.md`。
3. Storage に非公開バケット `org-files` を作る。
4. マイグレーションは gateway の起動時に `prisma migrate deploy` が流す（10/20/30/40 秒で最大 5 回リトライ、全滅なら起動しない）。手で流すなら:
   ```bash
   DATABASE_URL="<Session pooler の URL>" npx prisma migrate deploy --schema=packages/db-schema/prisma/schema.prisma
   ```
5. RLS は既定 off（`RLS_MODE=off`）。on にするのは `flow_app` ロールを作った後（O-5、`docs/design/multi-tenancy.md` §17）。
6. 無料プランは 7 日アクセスが無いと一時停止する。`.github/workflows/db-keepalive.yml` が予防する（`DATABASE_URL` シークレットが要る）。

## 3. Stripe

テストモードの商品・価格・税率・ポータル・webhook は 1 コマンドで用意できる（`docs/billing.md`）。

```bash
STRIPE_SECRET_KEY=sk_test_... npm run stripe:bootstrap                      # 確認だけ
STRIPE_SECRET_KEY=sk_test_... npm run stripe:bootstrap -- --apply \
  --webhook-url=https://<gateway>/api/webhooks/stripe                        # 作る。出た値を Render へ
```

- webhook の署名鍵（`STRIPE_WEBHOOK_SECRET`）は作成時にしか出ない。
- `STRIPE_SECRET_KEY` と `STRIPE_PRICE_STARTER_MONTHLY` の両方が入るまで「決済準備中」扱いで、トライアル切れでも誰も止めない。
- 本番キーに替える前に、事業者情報・登録番号（O-2）と法務の 3 頁（7 章）を埋める。

## 4. Render（gateway・ai-engine）

1. Render → **New → Blueprint** → このリポジトリ。`render.yaml` から 3 サービスができる（プランは `render.yaml` が正。ダッシュボードで変えても同期で戻る）。
2. `sync: false` のキーをダッシュボードで入れる。値の入ったキー（`NODE_VERSION`・`TRUST_PROXY_HOPS`・`ORG_HEADER_MODE`・`RLS_MODE` など）は `render.yaml` のまま。

**`org-ai-api-gateway`**

| キー | 値 |
|---|---|
| `DATABASE_URL` | Session pooler の URL |
| `JWT_SECRET` / `INTERNAL_API_TOKEN` / `N8N_WEBHOOK_AUTH_TOKEN` / `CHANNEL_CREDENTIAL_ENC_KEY` | 1 章 |
| `FRONTEND_URL` | Vercel の URL（カンマ区切り可。CORS 用で、URL の組み立てには使わない） |
| `AI_ENGINE_URL` | `https://org-ai-ai-engine.onrender.com` |
| `API_GATEWAY_URL` | gateway 自身の公開 URL（OAuth のコールバックと LINE webhook の表示に使う） |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | 3 章 |
| `STRIPE_PRICE_STARTER_MONTHLY` / `STRIPE_PRICE_STARTER_YEARLY` / `STRIPE_PRICE_PRO_MONTHLY` / `STRIPE_PRICE_PRO_YEARLY` / `STRIPE_PRICE_MAX_MONTHLY` / `STRIPE_PRICE_MAX_YEARLY` / `STRIPE_PRICE_STORAGE_ADDON` / `STRIPE_TAX_RATE_ID` | 3 章の出力 |
| `GEMINI_API_KEY` / `EMBEDDING_API_KEY` | 埋め込み用（`EMBEDDING_API_KEY` が空なら `GEMINI_API_KEY` を使う） |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | `docs/self-serve-integrations.md`。リダイレクト URI は `https://<gateway>/api/oauth/google/callback` |
| `N8N_CLOUD_URL` / `N8N_API_KEY` | n8n を使うときだけ |

`ALLOWED_ORIGIN_HOSTS` と `APP_BASE_URL` は `render.yaml` に公開フロントのホストで入っている。独自ドメインにしたらここを変える。

**`org-ai-ai-engine`**

| キー | 値 |
|---|---|
| `DATABASE_URL` | gateway と同じ 1 本（未設定だと AILog が欠け、AI の月間上限も効かない） |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | 1 章 |
| `INTERNAL_API_TOKEN` | gateway と同じ値 |
| `API_GATEWAY_URL` | gateway の公開 URL |
| `ADMIN_EMAILS` | 常に Claude を使う人のメール（カンマ区切り。任意） |

3. デプロイして 2 サービスが Live になるのを待つ。手元から操作するなら `scripts/render-deploy.mjs`（`RENDER_API_KEY` が要る）:
   ```bash
   npm run render:status    # 読むだけ（既定）
   npm run render:deploy
   npm run render:verify    # /health を待つ
   ```

## 5. Vercel（web）

| 項目 | 値 |
|---|---|
| Root Directory | 空（リポジトリのルート） |
| Framework / Build / Output / Install | `vercel.json` に従う（ダッシュボードの上書きは外す） |
| Node.js Version | 22.x |
| 環境変数 | `VITE_API_URL=https://<gateway>/api`、`VITE_WS_URL=wss://<gateway>` |

プロジェクト側がまだ Root Directory=`apps/web` のまま（O-4）なら、素の `vercel deploy --prod` は `No Output Directory named "dist"` で落ちる。設定を直すまでは手元で組んで送る:

```bash
vercel pull --yes --environment production
vercel build --prod
vercel deploy --prebuilt --prod --yes
```

公開 URL が変わったら gateway の `FRONTEND_URL`・`ALLOWED_ORIGIN_HOSTS`・`APP_BASE_URL` を合わせる。

## 6. 確かめる

1. `curl https://<gateway>/health` → 200、`/ready` → 200（DB に届いている）。`https://<ai-engine>/health` → 200。
2. オーナーでログインして **設定 > 基本 の「セットアップ状況」**がすべて「設定済み」（保存先と ai-engine に実際に問い合わせて判定する）。
3. 通し: 登録 → チャットで 1 回指示 → ファイルを 1 つ保存 → 設定 > プラン → Checkout（テストカード `4242 4242 4242 4242`）→ 戻って「ご契約中」→ ポータルで解約 → 期間終了後に書き込みが 402。
4. 未ログインで `/legal/terms` `/legal/privacy` `/legal/tokushoho` が開く。
5. スマホ実機で 登録 → チャット → 設定 > プラン（O-10）。

## 7. 公開の前に

| 項目 | どこ |
|---|---|
| 法務の 3 頁の文面と事業者情報（O-7） | `apps/web/src/pages/legal/content.ts` の `value: null` を埋める（画面には「未記入」と出ている） |
| Stripe の本番申請と本番キー（O-2） | 3 章を本番モードでやり直す |
| Gemini の有料化（O-11） | `GEMINI_PAID_TIER=true` を gateway と ai-engine に |
| アプリのアイコン（O-8） | `apps/web/public/icons/` を同名・同寸法で差し替え |
| 独自ドメイン | Vercel の Domains と gateway の CORS・`APP_BASE_URL` |
| 履歴に載った鍵の掃除 | 鍵を作り直して本番に入れた**後**に `git filter-repo`（force push を伴うのでオーナーが判断する） |

## 8. 困ったとき

| 症状 | 見るところ |
|---|---|
| gateway が起動しない（ログに起動拒否） | `JWT_SECRET` が 32 文字未満か見本の値、`N8N_WEBHOOK_AUTH_TOKEN` が未設定か既定値（`docs/security.md`） |
| `P1001: Can't reach database server` | ① direct ではなく Session pooler か ② Supabase が一時停止していないか（ダッシュボードで再開） ③ `?sslmode=require` ④ `DATABASE_URL` が現行のホストか。切り分けは `npx prisma migrate status --schema=packages/db-schema/prisma/schema.prisma` |
| ブラウザで CORS エラー | gateway の `FRONTEND_URL` / `ALLOWED_ORIGIN_HOSTS` に公開 URL が無い |
| 全員が 429 | `TRUST_PROXY_HOPS` の段数のずれ（`docs/security.md`） |
| AI の応答が 401 / 届かない | `INTERNAL_API_TOKEN` が gateway と ai-engine で違う。`AI_ENGINE_URL` |
| 契約が反映されない | Stripe の webhook の宛先と `STRIPE_WEBHOOK_SECRET`。Stripe ダッシュボードの webhook の配信記録 |
| 再デプロイでファイルが消えた | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` が未設定でローカル保存になっている |
| Render のプランが戻る | ダッシュボードで変えた。`render.yaml` の `plan` を変える |
