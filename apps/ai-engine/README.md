# ai-engine

FastAPI（Python 3.11）の AI 処理サービス。ポート 8000。
Intent 分類・部署エージェント・プランナー・LLMRouter（松竹梅ルーティング）・PII 検知・AILog 記録を担う。
呼び出し元は api-gateway と n8n だけ（ブラウザからは呼ばない）。

## 主要ディレクトリ

| パス | 内容 |
|---|---|
| `app/main.py` | エンドポイントと内部トークン（`x-internal-token`）の middleware |
| `app/config.py` | 環境変数の唯一の読み口（`settings`） |
| `app/orchestrator/` | Intent 分類 → 部署エージェントへの振り分け |
| `app/agents/` | 部署エージェント（sales / marketing / accounting / analytics / general） |
| `app/planner/` | capability / エージェント / HTTP ノードの計画、領収書の読み取り |
| `app/llm/router.py`, `app/llm/providers/` | LLMRouter と Anthropic / Gemini プロバイダ |
| `app/governance/` | PII 検知・AILog 記録・月間利用量 |
| `app/db.py` | `DATABASE_URL`（Prisma 形式）を SQLAlchemy(async) 用に変換 |
| `tests/` | pytest |

## エンドポイント

| メソッド・パス | 用途 |
|---|---|
| `GET /health` / `GET /ready` | 死活 / 設定状況（API キーの有無） |
| `POST /orchestrate` / `POST /orchestrate/stream` | チャット（部署の自動選択。stream は SSE） |
| `POST /llm/chat` | 汎用の LLM 呼び出し（gateway・n8n・ステップの `llm_transform`） |
| `POST /plan` / `/plan/agent` / `/plan/http-node` / `/rank` | プランナー系 |
| `POST /vision/receipt` | 領収書画像の読み取り |

`INTERNAL_API_TOKEN` が設定されていれば `/health` `/docs` `/redoc` `/openapi.json` 以外は `x-internal-token` が必要。

## コマンド

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt

.venv/bin/uvicorn app.main:app --reload --port 8000   # 起動（リポジトリ直下の .env を python-dotenv で読む）
.venv/bin/ruff check .                                 # lint（ルートから: npm run lint:ai）
.venv/bin/mypy                                         # 型チェック（npm run typecheck:ai）
.venv/bin/python -m pytest -q                          # テスト（npm run test:ai）
.venv/bin/python -m pytest --cov                       # カバレッジ
```

ツールの設定は `pyproject.toml`（ruff / pytest / coverage / mypy）。`requirements-dev.txt` は開発・CI 用で、
本番イメージ（`Dockerfile`）は `requirements.txt` だけを入れる。

## 環境変数

`app/config.py` が一覧。説明はルートの [.env.example](../../.env.example)（`[ai]` の付いたもの）。

- `ANTHROPIC_API_KEY`（必須）、`GEMINI_API_KEY`（梅/竹。無ければ Claude にフォールバック）、`GEMINI_PAID_TIER`
- `ADMIN_EMAILS`、`GEMINI_MODEL_UME` / `GEMINI_MODEL_TAKE` / `GEMINI_MODEL_JSON`
- `DATABASE_URL`（AILog の書き込みと利用量の集計）、`API_GATEWAY_URL`（CORS）、`INTERNAL_API_TOKEN`

`os.environ` を直接読まず `settings.*` を使うこと（毎回読み直すので monkeypatch が効く）。

## 規約

- LLM 呼び出しは必ず `llm_router` 経由（PII マスク・モデル選択・上限超過時の降格がここに集まっている）。
- AI の入出力は `audit_logger.schedule_llm_log` で AILog に記録する。入力はマスク後を残す。
- ログは `logging.getLogger(__name__)`。`print` は使わない。

## テスト

- LLM プロバイダはスタブ、DB はモックで、API キーも DB も不要。
- `tests/test_main_api.py` は HTTP API の形（ステータス・レスポンスのキー）を固定する特性テスト。
- `tests/fixtures`（リポジトリ直下）は gateway と共有する契約テストのフィクスチャ。

整理で見送った項目と既知の問題は [docs/maintenance/cleanup-hold-list.md](../../docs/maintenance/cleanup-hold-list.md)。
