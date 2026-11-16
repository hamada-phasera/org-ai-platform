# @org-ai/db-schema

PostgreSQL のスキーマ（Prisma）。本番は Supabase、ローカルは docker-compose の postgres。
api-gateway が Prisma Client で読み書きし、ai-engine（AILog / RiskEvent / 利用量）と
usage-metrics-svc（AILog の集計）は同じテーブルを SQL で直接読む。

## 中身

| パス | 内容 |
|---|---|
| `prisma/schema.prisma` | スキーマ（`provider = "postgresql"`、`url = env("DATABASE_URL")`） |
| `prisma/migrations/` | マイグレーション。pgvector（`CREATE EXTENSION vector`）を使う |
| `prisma/seed.ts` | デモ組織 `demo-org-001` とユーザー `admin@demo.com` / `demo1234` を作る |
| `prisma/seed-capabilities.ts` | 組織に既定の capability を入れる（手動実行。`ORG_ID` 未指定なら最古の組織） |

## コマンド

`DATABASE_URL` をシェルに入れてから実行する（prisma はリポジトリ直下の `.env` を読まない）。

```bash
npm run generate        # Prisma Client 生成（ルートから: npm run prisma:generate）
npm run migrate:dev     # スキーマ変更 → マイグレーション作成（開発用）
npm run migrate:deploy  # 既存のマイグレーションを適用（本番・CI 相当）
npm run seed            # デモデータ
npm run studio          # Prisma Studio
npm run typecheck       # prisma/*.ts の型チェック
npm run lint
```

`seed-capabilities.ts` は `DATABASE_URL=... ORG_ID=<org id> npx tsx packages/db-schema/prisma/seed-capabilities.ts`。

## 注意

- ⚠️ ローカルの `postgres:16-alpine` には pgvector が無く、マイグレーションが失敗する。pgvector 入りのイメージを使うこと
  （[docs/maintenance/cleanup-hold-list.md](../../docs/maintenance/cleanup-hold-list.md)）。
- `department` / `role` / `status` / `taskType` は enum ではなく String。値の集合は shared-types とスキーマのコメントにあり、
  `ontology-check` ワークフローが語彙のズレを検査している。
- テストは無い（gateway のテストは Prisma をモックする）。
