FROM node:22-alpine AS build
WORKDIR /app

ARG VITE_API_URL=/api
# 空なら開いているページと同じホストに WebSocket を張る（nginx が /api/tasks/ を中継）
ARG VITE_WS_URL=

# ワークスペース定義ファイル
COPY package*.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/web/package.json ./apps/web/

RUN npm install --workspaces --include-workspace-root

COPY packages/shared-types ./packages/shared-types
COPY apps/web ./apps/web

# shared-types ビルド
RUN npm run build --workspace=packages/shared-types

# web ビルド（環境変数を注入）
RUN VITE_API_URL=${VITE_API_URL} VITE_WS_URL=${VITE_WS_URL} npm run build --workspace=apps/web

FROM nginx:alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
