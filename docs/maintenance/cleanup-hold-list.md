# 整理（2026-11）で見送った項目と既知の問題

2026-11 のリファクタ（ブランチ `refactor/cleanup-2026-11`）は**アプリの挙動を変えない**ことを優先した。
ここには、判断が微妙で残したもの・直すと挙動が変わるので見送ったものをまとめる。
着手するときは別のコミット（できれば別 PR）で「挙動の変更」として扱うこと。

もとはルートの `HOLD_LIST.md`（TypeScript 側）と `apps/ai-engine/HOLD_LIST.md`（Python 側）だった。

## 1. 要確認の既知の問題（挙動が変わるので手を付けていない）

優先度の高い順。ai-engine 側の詳細は 3 章にもある。

| # | 問題 | 場所 | メモ |
|---|---|---|---|
| 1 | ~~`/orchestrate` が AILog に**マスク前**の入力を記録している~~ **解消（2026-11 チャンク 4）** | `apps/ai-engine/app/orchestrator/orchestrator.py` | `screen(user_message).text`（マスク後）を記録する |
| 2 | ~~`/rank` と `screen_agent`（`/plan/agent` の事前判定）が AILog に記録されない~~ **解消（2026-11 チャンク 4）** | `apps/ai-engine/app/main.py`, `app/planner/planner.py` | マスク後の値で AILog に記録し、月間上限の回数にも入る（`note_call` は LLMRouter の 1 か所のまま＝二重に数えない） |
| 3 | ~~`/orchestrate/stream` がエラー時に `str(e)` をそのまま返す~~ **解消（2026-11 チャンク 4）** | `apps/ai-engine/app/main.py` | `/orchestrate` は 503 / 502、`/orchestrate/stream` は SSE の error。どちらも固定文言（`ERROR_AI_NOT_CONFIGURED` / `ERROR_AI_FAILED`）で、詳細は `logger.exception` だけ |
| 4 | ~~`AI_ENGINE_URL` 未設定時の既定値が呼び出し元で違う~~ **解消（2026-11 チャンク 8）** | `apps/api-gateway/src/config/env.ts` | 既定は `http://localhost:8000` の 1 つに揃えた。compose は `AI_ENGINE_URL=http://ai-engine:8000` を渡す |
| 5 | ~~docker-compose の Postgres に pgvector が無い~~ **解消（2026-11 チャンク 8）** | `docker-compose.yml` | `pgvector/pgvector:pg16` に差し替え。`scripts/check-deploy-config.mjs` が検査する |
| 6 | ~~`scripts/start-dev.sh` に SQLite 時代の DB 初期化が残っている~~ **解消（2026-11 チャンク 8）** | `scripts/start-dev.sh` | Postgres に `migrate deploy` するだけにした（DB は `docker compose up -d postgres`） |
| 7 | ~~ai-engine の `DATABASE_URL` 既定値が `file:./data/app.db`（SQLite）~~ **解消（2026-11 チャンク 4）** | `apps/ai-engine/app/config.py`, `app/main.py` | 既定値は残し（テストが固定）、未設定なら起動時に警告する（`settings.database_url_configured`）。render.yaml・compose は ai-engine に `DATABASE_URL` を渡す（`check:deploy` が検査） |
| 8 | ~~gateway の `/ready` が DB 接続失敗時に例外メッセージを返す~~ **解消（2026-11 チャンク 7）** | `apps/api-gateway/src/routes/health.ts` | 503 は固定文言。例外はログにだけ出す |
| 9 | ~~AILog の model が実際のモデルと違うことがある（`/plan` は降格前のモデル名を記録）~~ **解消（2026-11 チャンク 4）** | `apps/ai-engine/app/main.py` | 応答の実モデル名を記録する。応答が無いときだけ事前に決めたモデル名 |
| 10 | web の ESLint 警告 9 件（`react-hooks/set-state-in-effect`。2026-11 時点） | `apps/web/src/**` | effect 内で setState。直すと描画タイミングが変わるので、各箇所にコメントを付けて残した |
| 11 | 古いドキュメントに SQLite 前提の手順が残っている | `docs/MASTERY_GUIDE.md`, `docs/work-log.md`, `docs/変更メモ.md`, `tasks/00-setup.md` ほか | docs/ と tasks/ の既存文書は今回の対象外。README と docs/ARCHITECTURE.md を正とする |

## 2. TypeScript 側 — 未使用判定だが削除を保留したもの

knip（`npx -y knip@5`、ルートの `knip.json` で `ignoreExportsUsedInFile: true`）が
未使用と判定したもののうち、**確実に未使用とは言い切れない／担当外**のため残したもの。

### ファイル

| 項目 | 理由 |
|---|---|
| `apps/web/demo/orb-gen/build-gen.mjs`, `apps/web/demo/orb-gen/gen-export.mts` | 開発用のデモ生成スクリプト。手動実行される前提でエントリから参照されない |
| `apps/web/demo/verify/rm-test.css`, `apps/web/demo/verify/safari-test.css` | ブラウザ検証用の手動テスト素材 |
| `design-canvas/apply-sidebar.mjs`, `design-canvas/build-accent-compare.mjs`, `design-canvas/stripe-v3/build-stripe.mjs` | design-canvas は作業範囲外（手動実行のデザインツール） |
| `docs/pricing/build-deck.mjs` | docs は別担当。手動で資料を生成するスクリプト |
| `packages/db-schema/prisma/seed-capabilities.ts` | `ts-node` で手動実行する seed の可能性が高い（package.json の `seed` は seed.ts のみだが、運用手順で使われうる） |

### 依存

| 項目 | 理由 |
|---|---|
| `apps/api-gateway`: `mammoth`, `pdf-parse` | `src/utils/fileExtractor.ts` で `new Function('m','return import(m)')` による動的 import。静的解析では見えない |
| `apps/api-gateway`: `@types/ws` | `@fastify/websocket` の型定義が `ws` を import しており、WebSocket ハンドラの型解決に必要 |
| `apps/web`: `@types/lodash` | knip の初回レポートでは未使用だったが、`recharts` の型定義（`generateCategoricalChart.d.ts`）が `lodash` を import しており、web は `skipLibCheck` 無しのため削除すると `tsc` が TS7016 で落ちる（削除して確認済み） |

### export

| 項目 | 理由 |
|---|---|
| `api-gateway/src/services/http-node/client.ts`: `resetHttpNodeAgent` | テスト用のリセットフック（現状どのテストからも未参照だが、モジュール内の keep-alive Agent を作り直す意図的な口） |
| `api-gateway/src/routes/accounting/shared.ts`: `jstDateOnly` | 「保存する日付は必ずこれを通す」という規約を持つ日付ヘルパー。今は未使用だが、日付保存を追加するときの正しい入口として残す |
| `api-gateway/src/routes/sales/pipeline-core.ts`: `Deal`（型） | API レスポンス形の定義（ドキュメントとしての型）。`pipeline.ts` から型として再参照される |
| `web/src/components/Analytics/kpiEvents.ts`: `deriveCostUsd`, `PLACEHOLDER_MODEL_RATE_USD_PER_1K`, `KpiEventKind`, `DepartmentKpi` | gateway `routes/analytics/kpi-events.ts` の契約ミラー（A-2 画面 / A-3 集計 API 用に提案中の形）。統合フェーズで使う前提のため残す |

> `storage/driver.ts` の `resetStorageDrivers` は今回追加した `storage-driver.test.ts` から使うようになったので、保留から外れた。

### knip の設定について

- `ignoreExportsUsedInFile: true` にした。**同じファイル内で使われている export** は未使用扱いしない
  （export を外すだけの差分が大量に出て、レビューの妨げになるため）。
- 型の export（`Unused exported types`）は、上記設定で 4 件まで減った。残りは上表のとおり保留。

## 3. ai-engine 側 — 消さなかった / 直さなかったもの

（もとのブランチ名は `wip/py-cleanup`。番号付きの問題は 1 章の表と重複するものがある）

### 1. 未使用に見えるが残したコード

| 対象 | 理由 |
|---|---|
| `app/db.py` `get_db()` | リポジトリ内に参照なし。FastAPI の `Depends` 用ヘルパの定番形で、今後エンドポイントから DB を使うときの入口になりうるので残置（戻り値型だけ `AsyncIterator[AsyncSession]` に修正）。 |
| `app/governance/usage.py` `reset_cache()` | 本番コードからは未使用だがテストが使う（docstring にも「テスト用」と明記）。 |
| `app/orchestrator/intent_classifier.py` `DEPARTMENTS` | 中では未使用。旧来の公開名なので `app.departments` からの再 import として残置。 |
| `app/models/llm.py` `OrchestateRequest.session_id` | ai-engine では読んでいないが、gateway が送ってくる契約上のフィールド。 |
| vulture の 60% 判定（pydantic のフィールド、FastAPI のルート関数、middleware） | フレームワーク経由で使われる誤検出。 |

### 2. 名前・形の不整合（変えると外部契約が変わる）

- **`OrchestateRequest`（"r" 抜けの typo）**: OpenAPI のスキーマ名がこのクラス名になるため据え置き。
  直すなら `OrchestrateRequest` を新設し、旧名をエイリアスにして OpenAPI の差分を確認すること。
- **`TaskKind(str, Enum)`**: ruff UP042 は `StrEnum` を勧めるが、`str(TaskKind.CHAT)` の結果が
  `"TaskKind.CHAT"` → `"chat"` に変わるので `noqa` で据え置き。
- **`/rank` の JSON パース**: `planner._safe_parse_json` と順序が違う（`/rank` はコードフェンスを先に剥がす）。
  フェンス文字を本文に含む正しい JSON で結果が変わるので共通化していない。

### 3. 見つけたが直していない問題（挙動が変わるもの）

> 1〜4 は 2026-11 のチャンク 4 で解消した（1 章の表の 1・2・3・9）。経緯として残す。残っているのは 5 だけ。

優先度の高い順です。

1. **`/orchestrate` が AILog にマスク前の入力を記録している** (`app/orchestrator/orchestrator.py`)。
   `input_text=user_message`（生の入力）を渡している。LLM へ送る分は router でマスクされるが、
   AILog には平文のメール・電話番号・資格情報が残る。`/orchestrate/stream` と `/llm/chat` は
   マスク後を記録しており、コメントにも「マスク後だけを残す」とある。CLAUDE.md の
   「PII 検知を通過してから」の趣旨とも食い違う。
   → `screen(user_message).text` を記録するのが正しいはず（テスト
   `tests/test_agents.py::TestOrchestrator::test_process_logs_call` に足せる）。
2. **AILog に残っていない LLM 呼び出しがある**: `/rank` と、`/plan/agent` の `screen_first`
   判定（`screen_agent`、Haiku）。CLAUDE.md の「すべての AI 入出力を AILog に記録」に反する。
   これらは月間上限の判定に使う回数にも入らない（判定は AILog の件数で数えている）。
3. **AILog の model が実際のモデルと違うことがある**: `/plan` は `resolve_provider_model()` で
   モデル名を出し直して記録しているが、上限超過で軽いモデルに降格していると実際とずれる。
   `/llm/chat` と同じように、実際の応答（`response.model`）を記録するのが確実。
4. **`/orchestrate/stream` がエラーの `str(e)` をそのままクライアントに返す**。SDK の例外文言に
   内部情報が入りうる（CLAUDE.md「シークレットとエラー文言は利用者に返さない」は決済の節だが同じ趣旨）。
5. **領収書の読み取りは router を通らない**（provider 直呼び）。画像なので PII 検知の対象外なのは
   意図どおりだが、`note_call()` が呼ばれないので利用量のキャッシュが進まない。影響は軽微。

### 4. テスト・ツールまわり

- **古いテストがプロセス全体の環境変数を書き換える**: `tests/test_plan_models.py` と
  `tests/test_usage_limits.py` が import 時に `os.environ.setdefault("GEMINI_API_KEY", ...)` する。
  後続のテストに漏れる（今回の新しいテストは `no_gemini` / `with_gemini` フィクスチャで
  明示的に上書きしているので影響は受けない）。monkeypatch のフィクスチャに移すのが望ましい。
- **古いテストは `anthropic` SDK をスタブする**（未 import のときだけ）。SDK は venv に入っているので
  不要になっているが、`tests/fixtures`（リポジトリ直下・gateway と共有）を読む契約テストなので触っていない。
- **`ruff format` は全体には適用していない**: 適用すると 14 ファイル・約 230 行が変わり、
  `pii_screener.py` の規則表のような読みやすさのために手で揃えた箇所も崩れる。今回の新規ファイル
  （テスト・`config.py` など）にだけ適用した。全体に適用するなら単独のコミットで行い、
  `.git-blame-ignore-revs` に登録するとよい。
- **mypy は緩め**（`check_untyped_defs` のみ）。`anthropic_provider` は SDK の TypedDict に dict を
  渡している箇所が通らないので、そのモジュールだけ `arg-type` などを無効化している。
  `MessageParam` / `TextBlockParam` で組み立て直せば外せる。
- 開発用 venv は Python 3.13、本番 Dockerfile は 3.11。ruff/mypy の target は 3.11 に合わせてある。

## 追記: Node バージョンの不一致（解消: 2026-11 チャンク 8）
- `apps/api-gateway` の依存 `undici@^8` は `engines.node >=22.19.0`。Node 22 未満では `services/http-node/client.ts` の
  import 時に `webidl.util.markAsUncloneable is not a function` で落ちる。
- Dockerfile（`node:22-alpine`）・`.node-version`・`package.json` の `engines`・`render.yaml` の `NODE_VERSION`・CI を 22 に揃え、
  `scripts/check-deploy-config.mjs`（`npm test`）が 22 未満を検出する。
