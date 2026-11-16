# HOLD_LIST — ai-engine 整理で「消さなかった / 直さなかった」もの

2026-11 の整理（ブランチ `wip/py-cleanup`）では**挙動を一切変えない**ことを優先しました。
ここに並んでいるのは、判断が微妙だったもの、または直すと挙動が変わるので見送ったものです。
着手するときは、別のコミット（できれば別 PR）で挙動の変更として扱ってください。

## 1. 未使用に見えるが残したコード

| 対象 | 理由 |
|---|---|
| `app/db.py` `get_db()` | リポジトリ内に参照なし。FastAPI の `Depends` 用ヘルパの定番形で、今後エンドポイントから DB を使うときの入口になりうるので残置（戻り値型だけ `AsyncIterator[AsyncSession]` に修正）。 |
| `app/governance/usage.py` `reset_cache()` | 本番コードからは未使用だがテストが使う（docstring にも「テスト用」と明記）。 |
| `app/orchestrator/intent_classifier.py` `DEPARTMENTS` | 中では未使用。旧来の公開名なので `app.departments` からの再 import として残置。 |
| `app/models/llm.py` `OrchestateRequest.session_id` | ai-engine では読んでいないが、gateway が送ってくる契約上のフィールド。 |
| vulture の 60% 判定（pydantic のフィールド、FastAPI のルート関数、middleware） | フレームワーク経由で使われる誤検出。 |

## 2. 名前・形の不整合（変えると外部契約が変わる）

- **`OrchestateRequest`（"r" 抜けの typo）**: OpenAPI のスキーマ名がこのクラス名になるため据え置き。
  直すなら `OrchestrateRequest` を新設し、旧名をエイリアスにして OpenAPI の差分を確認すること。
- **`TaskKind(str, Enum)`**: ruff UP042 は `StrEnum` を勧めるが、`str(TaskKind.CHAT)` の結果が
  `"TaskKind.CHAT"` → `"chat"` に変わるので `noqa` で据え置き。
- **`/rank` の JSON パース**: `planner._safe_parse_json` と順序が違う（`/rank` はコードフェンスを先に剥がす）。
  フェンス文字を本文に含む正しい JSON で結果が変わるので共通化していない。

## 3. 見つけたが直していない問題（挙動が変わるもの）

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

## 4. テスト・ツールまわり

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
