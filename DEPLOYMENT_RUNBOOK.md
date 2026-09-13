# Deployment Runbook — org-ai-platform (FLOW)

Target architecture:
- **Web (Vite SPA)** → Vercel
- **API Gateway (Fastify)** → Render (Node service)
- **AI Engine (FastAPI)** → Render (Python service)
- **DB** → Supabase Postgres（us-west-2 / pg17。project ref と接続文字列はダッシュボード / パスワードマネージャ参照）
  - 2026-08 に Neon から移行済み。旧 Neon プロジェクトは 2026-07-08 で更新が止まっているので参照しない
- **n8n** (optional) → Render image / n8n Cloud

---

## Phase 0 — Secrets rotation (do immediately before deploy)

You must rotate every key that has touched git history.

| Key | Where to rotate |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com — revoke old, create new |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey — revoke old, create new |
| `N8N_API_KEY` | n8n Cloud → Settings → API → revoke + recreate |
| `JWT_SECRET` | `openssl rand -hex 32` |
| Postgres password | created fresh in Supabase (Project Settings → Database → Reset password) |

After rotation, save the values in your password manager — do **not** commit them anywhere.

---

## Phase 1 — Provision Supabase Postgres

> 現行プロジェクトは既にある（us-west-2 / pg17）ので作り直す必要は無い。
> 以下はゼロから作る場合の手順。

1. Sign in / create project at https://supabase.com/dashboard
2. Create a project: `org-ai-platform`（DB 名は `postgres` 固定。Neon 時代の `orgai` ではない）
3. Project Settings → Database → Connection string から **Session pooler**（`aws-0-<region>.pooler.supabase.com` の **5432**）を 1 本コピーする。
   `?sslmode=require` を付ける。gateway・ai-engine ともこの 1 本で統一する。
4. 他の 2 経路は使えない（[docs/supabase-migration.md](docs/supabase-migration.md) に実測あり）:
   - **direct**（`db.<ref>.supabase.co:5432`）… IPv6 のみで IPv4 が無い。Render から `P1001` になる
   - **transaction pooler**（6543）… Prisma がマイグレーション時に取るセッションスコープの advisory lock が維持できず失敗する
5. Save it.

⚠️ 無料プランは 7 日間アクセスが無いとプロジェクトが一時停止し、手動で再開するまで DB に到達できない。
   [.github/workflows/db-keepalive.yml](.github/workflows/db-keepalive.yml) がその予防用だが、
   `DATABASE_URL` シークレット未設定の間は何もしない。

---

## Phase 2 — Deploy API Gateway + AI Engine to Render

### Option A — from render.yaml (recommended)

1. Push your repo to GitHub (already done).
2. Render Dashboard → **New → Blueprint** → pick this repo.
3. Render reads [render.yaml](render.yaml) and creates 3 services.
4. For each service, set the env vars marked `sync: false`:

**`org-ai-api-gateway`**:
```
NODE_ENV=production
DATABASE_URL=<Supabase Session pooler URL :5432>   # migrations + app use
JWT_SECRET=<32+ chars>
ANTHROPIC_API_KEY=<new>
GEMINI_API_KEY=<optional>
FRONTEND_URL=https://<your-vercel-domain>    # comma-separated if multi
AI_ENGINE_URL=https://org-ai-ai-engine.onrender.com
# Optional provider keys
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
# Optional n8n
N8N_CLOUD_URL=
N8N_API_KEY=
N8N_WORKFLOW_ID=
N8N_WEBHOOK_AUTH_TOKEN=
```

**`org-ai-ai-engine`**:
```
DATABASE_URL=<Supabase Session pooler URL :5432>   # gateway と同じ 1 本
ANTHROPIC_API_KEY=<new>
GEMINI_API_KEY=<optional>
API_GATEWAY_URL=https://org-ai-api-gateway.onrender.com
```

5. Trigger deploy. Wait for both services to be **Live**.
6. Verify:
   - `curl https://org-ai-api-gateway.onrender.com/health` → `{ "status": "ok" }`
   - `curl https://org-ai-ai-engine.onrender.com/health` → `{ "status": "ok" }`

### Option B — manual (if blueprint flow has issues)

Create two Web Services manually with:
- Build/Start commands copied from [render.yaml](render.yaml)
- Root dir only for ai-engine (`apps/ai-engine`)
- All env vars from above

---

## Phase 3 — Deploy Web to Vercel

### 3a. Link project
```bash
npm i -g vercel
cd /Users/hamadahiromu/Desktop/AiProject/org-ai-platform
vercel link
```
Pick the team, create or link the project `org-ai-platform`.

### 3b. Set env vars
```bash
vercel env add VITE_API_URL production
# paste: https://org-ai-api-gateway.onrender.com/api

vercel env add VITE_WS_URL production
# paste: wss://org-ai-api-gateway.onrender.com
```
Also add them to `preview` (same values) if you want previews to hit prod backend,
or create a staging Render service for previews.

### 3c. Update CORS allowlist on gateway
Once Vercel gives you a production URL (`https://<project>.vercel.app`),
go to Render → `org-ai-api-gateway` → Environment → update `FRONTEND_URL`
to include that domain (comma-separated if you have a custom domain too).
Redeploy gateway.

### 3d. First production deploy
```bash
vercel --prod
```

---

## Phase 4 — Run DB migrations on Supabase

Gateway runs `prisma migrate deploy` in its Render startCommand, so the first
deploy applies all migrations automatically. To run manually:

```bash
export DATABASE_URL="<Supabase Session pooler URL :5432>"
npx prisma migrate deploy --schema=packages/db-schema/prisma/schema.prisma
```

To seed the demo user (`admin@demo.com / demo1234`):
```bash
npx tsx apps/api-gateway/prisma/seed.ts   # if seed exists; otherwise register via UI
```

---

## Phase 5 — End-to-end verification

Hit each checkpoint on your production domain:

- [ ] `GET /` renders Dashboard (login redirects)
- [ ] `/register` → create org + user → auto-login → redirected to `/`
- [ ] `/login` with demo creds works (if seeded)
- [ ] Click a department card → `/chat/:id` opens → send message → streamed reply
- [ ] `/tasks` shows task list, can create a task
- [ ] `/deliverables` shows completed task outputs
- [ ] `/governance` shows logs + risks (OWNER role only)
- [ ] `/settings` shows user + file list, can upload a file
- [ ] BottomNav works on every page
- [ ] Refresh on any page keeps auth (token persisted)

Check DevTools:
- No red console errors on any route
- Network tab: `/api/*` all go to the Render gateway, return 200/2xx
- No CORS failures (if CORS errors: update `FRONTEND_URL` on Render)

---

## Phase 6 — Post-launch cleanup

- [ ] **Git history scrub**: remove historical `apps/web/.env.local` and docker-compose n8n key from git:
  ```bash
  # install once
  brew install git-filter-repo

  # from a fresh clone (filter-repo requires it):
  git clone https://github.com/hamahiro1668/org-ai-platform.git scrub
  cd scrub
  git filter-repo --path apps/web/.env.local --invert-paths
  # for the n8n key in docker-compose, use a replace file:
  echo 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9==>REDACTED' > /tmp/replacements.txt
  git filter-repo --replace-text /tmp/replacements.txt
  git push --force origin main
  ```
  Do this **only after** the old keys are revoked and the new keys are deployed.

- [ ] Enable Vercel Web Analytics + Speed Insights on project
- [ ] Set up Render log drain or Vercel Observability (optional)
- [ ] Add a custom domain on Vercel + update CORS allowlist

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Render gateway crashes: "DATABASE_URL is not set" | Add the Supabase URL env var and redeploy |
| Render gateway crashes: "JWT_SECRET is required" | `openssl rand -hex 32` → set env |
| Frontend 401 on every API call | Token not being sent — check `VITE_API_URL` matches gateway, check CORS `FRONTEND_URL` |
| CORS error in browser | Gateway `FRONTEND_URL` missing your Vercel domain |
| Prisma P1001 can't reach DB | ① direct (`db.<ref>.supabase.co`) を使っていないか（IPv4 が無く Render から不達）→ **Session pooler :5432** に直す ② プロジェクトが一時停止していないか → 再開 ③ `?sslmode=require` |
| AI Engine 500 "ANTHROPIC_API_KEY missing" | Set on both services (gateway forwards, engine calls) |

---

Owner: hamahiro1668
Last reviewed: 2026-04-14
