#!/usr/bin/env bash
# start-dev.sh — FLOW ローカル開発スタック起動スクリプト
#
# 3つのサービスを並列で起動します:
#   - api-gateway (Fastify / Node.js)    port 4000
#   - ai-engine   (FastAPI / Python)     port 8000
#   - web         (Vite / React)         port 3000
#
# 使い方:
#   ./scripts/start-dev.sh            # 全サービス起動
#   ./scripts/start-dev.sh --no-ai    # ai-engine を起動しない
#
# DB は Postgres（pgvector 入り）。先に `docker compose up -d postgres` で起動しておく。
# 起動前に .env をシェルに読み込み、`prisma migrate deploy` を流す（何度流しても同じ）。
#
# Ctrl+C で全プロセスを停止します。
# ⚠️ Docker だけで一式を動かすなら `docker compose up --build`（README「最短で動かす」）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

START_AI=1

for arg in "$@"; do
  case "$arg" in
    --no-ai) START_AI=0 ;;
    -h|--help)
      sed -n '2,19p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

# ---- color helpers ----
c_dim()   { printf '\033[2m%s\033[0m' "$1"; }
c_bold()  { printf '\033[1m%s\033[0m' "$1"; }
c_green() { printf '\033[32m%s\033[0m' "$1"; }
c_red()   { printf '\033[31m%s\033[0m' "$1"; }
c_cyan()  { printf '\033[36m%s\033[0m' "$1"; }

log() { echo "$(c_dim "[start-dev]") $1"; }
err() { echo "$(c_red "[start-dev]") $1" >&2; }

# ---- prereq checks ----
check_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "必要なコマンドが見つかりません: $1"
    return 1
  fi
}

log "$(c_bold 'FLOW 開発スタックを起動します')"
check_cmd node
check_cmd npm
[ "$START_AI" = "1" ] && check_cmd python3

# ---- env ----
if [ ! -f "$ROOT_DIR/.env" ]; then
  if [ -f "$ROOT_DIR/.env.example" ]; then
    log "$(c_cyan '.env') が見つからないため .env.example をコピーします"
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  else
    log ".env も .env.example も見つかりません (スキップ)"
  fi
fi

# api-gateway と prisma は .env を自分で読まないので、ここでシェルに読み込む
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/.env"
  set +a
fi

# ---- node deps ----
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  log "npm install を実行します…"
  npm install
fi

# ---- DB (Postgres) ----
if [ -z "${DATABASE_URL:-}" ]; then
  err "DATABASE_URL が未設定です（.env を確認）"
  exit 1
fi
log "Prisma のマイグレーションを適用します…"
npm run prisma:generate >/dev/null
npm run migrate:deploy --workspace=packages/db-schema || {
  err "マイグレーションに失敗しました。Postgres は起動していますか？ → docker compose up -d postgres"
  exit 1
}

mkdir -p "$ROOT_DIR/data/files"

# ---- python deps ----
if [ "$START_AI" = "1" ]; then
  AI_DIR="$ROOT_DIR/apps/ai-engine"
  VENV="$AI_DIR/.venv"
  if [ ! -d "$VENV" ]; then
    log "ai-engine の venv を作成します…"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --upgrade pip
    "$VENV/bin/pip" install --quiet -r "$AI_DIR/requirements.txt"
  fi
fi

# ---- process management ----
PIDS=()
cleanup() {
  log "$(c_cyan '停止中…')"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  log "$(c_green '停止完了')"
}
trap cleanup EXIT INT TERM

spawn() {
  local name="$1"
  shift
  log "起動: $(c_bold "$name")"
  (
    # プレフィックス付きで stdout/stderr を流す
    "$@" 2>&1 | sed -u "s|^|$(c_cyan "[$name]") |"
  ) &
  PIDS+=($!)
}

# api-gateway
spawn "api-gateway" npm run dev --workspace=apps/api-gateway

# ai-engine
if [ "$START_AI" = "1" ]; then
  spawn "ai-engine" bash -c "cd '$ROOT_DIR/apps/ai-engine' && '$ROOT_DIR/apps/ai-engine/.venv/bin/uvicorn' app.main:app --reload --host 0.0.0.0 --port 8000"
fi

# web
spawn "web" npm run dev --workspace=apps/web

log "$(c_green '全サービス起動中。Ctrl+C で停止します')"
log "  web:         http://localhost:3000"
log "  api-gateway: http://localhost:4000"
[ "$START_AI" = "1" ] && log "  ai-engine:   http://localhost:8000"

wait
