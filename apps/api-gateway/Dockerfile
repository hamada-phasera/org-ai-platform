FROM node:22-alpine AS builder
WORKDIR /app

# ワークスペース定義ファイル（レイヤーキャッシュ最適化）
COPY package*.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/db-schema/package.json ./packages/db-schema/
COPY apps/api-gateway/package.json ./apps/api-gateway/

RUN npm install --workspaces --include-workspace-root

# ソースコピー
COPY packages/shared-types ./packages/shared-types
COPY packages/db-schema ./packages/db-schema
COPY apps/api-gateway ./apps/api-gateway

# shared-types ビルド
RUN npm run build --workspace=packages/shared-types

# prisma client 生成
RUN npx prisma generate --schema=packages/db-schema/prisma/schema.prisma

# api-gateway ビルド
RUN npm run build --workspace=apps/api-gateway

# ランタイムイメージ
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api-gateway/dist ./apps/api-gateway/dist
COPY --from=builder /app/apps/api-gateway/package.json ./apps/api-gateway/

EXPOSE 4000

# DB migrate 後にサーバー起動
CMD ["sh", "-c", "npx prisma migrate deploy --schema=packages/db-schema/prisma/schema.prisma && node apps/api-gateway/dist/index.js"]
