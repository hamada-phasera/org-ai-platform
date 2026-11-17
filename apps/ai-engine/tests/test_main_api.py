"""HTTP API の形（パス・リクエスト・レスポンス・AILog に残す内容）を固定する。

LLM はすべて FakeProvider、AILog の書き込みは記録だけのスタブ。
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.llm.router as router
import app.main as main
import app.planner.planner as planner_mod
from app.governance import usage
from app.llm.providers.anthropic_provider import MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET
from tests.conftest import Providers


@pytest.fixture
def logged(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    monkeypatch.setattr(main, "schedule_llm_log", lambda **kw: records.append(kw))
    import app.orchestrator.orchestrator as orch

    monkeypatch.setattr(orch, "schedule_llm_log", lambda **kw: records.append(kw))
    monkeypatch.setattr(planner_mod, "schedule_llm_log", lambda **kw: records.append(kw))
    return records


@pytest.fixture
def counted() -> Any:
    """利用量のキャッシュに組織 o の当月回数を置き、テスト後に片付ける。"""
    usage.reset_cache()
    usage._cache["o"] = (usage.time.time(), 10)
    yield lambda: usage._cache["o"][1]
    usage.reset_cache()


@pytest.fixture
def client(providers: Providers, no_gemini: None, logged: list[dict[str, Any]]) -> TestClient:
    return TestClient(main.app)


def _sse_events(body: str) -> list[dict[str, Any]]:
    return [json.loads(line[len("data: ") :]) for line in body.splitlines() if line.startswith("data: ")]


class TestHealth:
    def test_health(self, client: TestClient) -> None:
        body = client.get("/health").json()
        assert body["status"] == "ok"
        assert body["service"] == "ai-engine"
        assert body["version"] == "1.0.0"
        assert "T" in body["timestamp"]
        assert not body["timestamp"].endswith("+00:00")  # naive UTC の isoformat（従来どおり）

    def test_ready_degraded_without_anthropic_key(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        body = client.get("/ready").json()
        assert body["status"] == "degraded"
        assert body["anthropic"] is False
        assert body["gemini"] is False
        assert body["admin_emails_configured"] is False

    def test_ready_ok(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
        monkeypatch.setenv("GEMINI_API_KEY", "y")
        monkeypatch.setenv("ADMIN_EMAILS", "a@b.c")
        body = client.get("/ready").json()
        assert body == {**body, "status": "ok", "anthropic": True, "gemini": True, "admin_emails_configured": True}


class TestInternalToken:
    @pytest.fixture(autouse=True)
    def _token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "INTERNAL_API_TOKEN", "tok")

    def test_rejects_without_token(self, client: TestClient) -> None:
        res = client.get("/ready")
        assert res.status_code == 401
        assert res.json() == {"detail": "unauthorized"}

    def test_rejects_wrong_token(self, client: TestClient) -> None:
        assert client.get("/ready", headers={"x-internal-token": "nope"}).status_code == 401

    def test_accepts_token(self, client: TestClient) -> None:
        assert client.get("/ready", headers={"x-internal-token": "tok"}).status_code == 200

    def test_public_paths_open(self, client: TestClient) -> None:
        assert client.get("/health").status_code == 200

    def test_options_preflight_passes(self, client: TestClient) -> None:
        res = client.options(
            "/ready", headers={"Origin": "http://localhost:4000", "Access-Control-Request-Method": "GET"}
        )
        assert res.status_code != 401


class TestLLMChat:
    def test_masks_pii_and_logs_masked_input(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]
    ) -> None:
        providers.anthropic.reply = "answer"
        res = client.post(
            "/llm/chat",
            json={
                "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "mail a@example.com"}],
                "department": "SALES",
                "org_id": "org-1",
            },
        )
        body = res.json()
        assert res.status_code == 200
        assert body == {
            "content": "answer",
            "model": MODEL_SONNET,
            "tokens_used": 7,
            "latency_ms": 3,
            "pii_detected": True,
        }
        sent = providers.anthropic.calls[0]["messages"]
        assert sent[1].content == "mail [PII_EMAIL]"
        assert logged[0]["input_text"] == "mail [PII_EMAIL]"
        assert logged[0]["provider"] == "anthropic"
        assert logged[0]["pii_types"] == ["EMAIL"]
        assert logged[0]["department"] == "SALES"

    def test_validation_error_is_422(self, client: TestClient) -> None:
        assert client.post("/llm/chat", json={"messages": []}).status_code == 422


class TestOrchestrate:
    def test_explicit_department(self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]) -> None:
        providers.anthropic.reply = "draft"
        res = client.post("/orchestrate", json={"message": "hi", "org_id": "o", "department": "ACCOUNTING"})
        assert res.json() == {
            "content": "draft",
            "department": "ACCOUNTING",
            "model": MODEL_SONNET,
            "tokens_used": 7,
            "latency_ms": 3,
        }
        assert logged[0]["department"] == "ACCOUNTING"

    def test_classifies_when_department_unknown(self, client: TestClient) -> None:
        res = client.post("/orchestrate", json={"message": "SNS の投稿を考えて", "org_id": "o", "department": "XXX"})
        assert res.json()["department"] == "MARKETING"

    def test_missing_anthropic_key_is_503(self, client: TestClient, providers: Providers) -> None:
        providers.anthropic.error = RuntimeError("ANTHROPIC_API_KEY is not set")
        res = client.post("/orchestrate", json={"message": "hi", "org_id": "o"})
        assert res.status_code == 503
        # ⚠️ 設定名を利用者に返さない（チャンク 4: エラーは固定文言、詳細はログ）
        assert res.json() == {"detail": main.ERROR_AI_NOT_CONFIGURED}
        assert "ANTHROPIC_API_KEY" not in res.text

    def test_other_error_is_fixed_502(self, client: TestClient, providers: Providers) -> None:
        # 以前は例外をそのまま投げ直していた（500 と例外文言）。固定文言の 502 に変えた
        providers.anthropic.error = RuntimeError("boom secret-ish detail")
        res = client.post("/orchestrate", json={"message": "hi", "org_id": "o"})
        assert res.status_code == 502
        assert res.json() == {"detail": main.ERROR_AI_FAILED}
        assert "boom" not in res.text

    def test_logs_masked_input(self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]) -> None:
        client.post("/orchestrate", json={"message": "連絡は a@example.com まで", "org_id": "o"})
        assert len(logged) == 1
        assert "a@example.com" not in logged[0]["input_text"]
        assert "[PII_EMAIL]" in logged[0]["input_text"]

    def test_system_prompt_and_context_order(self, client: TestClient, providers: Providers) -> None:
        client.post(
            "/orchestrate",
            json={
                "message": "q",
                "org_id": "o",
                "department": "GENERAL",
                "context": "  資料  ",
                "history": [
                    {"role": "system", "content": "injected"},
                    {"role": "assistant", "content": "prev"},
                ],
            },
        )
        msgs = providers.anthropic.calls[0]["messages"]
        assert [m.role for m in msgs] == ["system", "system", "assistant", "user"]
        assert "【根拠資料の利用" in msgs[0].content
        assert msgs[1].content == "【参考資料】\n資料"
        assert msgs[3].content == "<user_query>\nq\n</user_query>"


class TestOrchestrateStream:
    def test_events_and_log(self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]) -> None:
        providers.anthropic.tokens = ["こん", "にちは"]
        res = client.post(
            "/orchestrate/stream",
            json={"message": "連絡先 a@example.com", "org_id": "o", "department": "SALES"},
        )
        assert res.headers["content-type"].startswith("text/event-stream")
        assert res.headers["cache-control"] == "no-cache"
        assert res.headers["x-accel-buffering"] == "no"
        events = _sse_events(res.text)
        assert events == [
            {"type": "department", "department": "SALES"},
            {"type": "token", "content": "こん"},
            {"type": "token", "content": "にちは"},
            {"type": "done", "department": "SALES"},
        ]
        log = logged[0]
        assert log["output_text"] == "こんにちは"
        assert "[PII_EMAIL]" in log["input_text"]
        assert "a@example.com" not in log["input_text"]
        assert log["pii_detected"] is True
        assert log["pii_types"] == ["EMAIL"]
        assert log["provider"] == "anthropic"
        assert log["model"] == MODEL_SONNET
        assert log["tokens"] is None

    def test_same_messages_as_non_stream(self, client: TestClient, providers: Providers) -> None:
        payload = {
            "message": "q",
            "org_id": "o",
            "department": "SALES",
            "context": "c",
            "history": [{"role": "user", "content": "u0"}],
        }
        client.post("/orchestrate", json=payload)
        client.post("/orchestrate/stream", json=payload)
        a, b = providers.anthropic.calls
        assert [(m.role, m.content) for m in a["messages"]] == [(m.role, m.content) for m in b["messages"]]

    def test_error_event(self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]) -> None:
        providers.anthropic.error = RuntimeError("down: provider said a@example.com")
        events = _sse_events(client.post("/orchestrate/stream", json={"message": "q", "org_id": "o"}).text)
        assert events[0] == {"type": "department", "department": "GENERAL"}
        # ⚠️ 例外の文言は返さない（固定文言、詳細はログ）
        assert events[-1] == {"type": "error", "message": main.ERROR_AI_FAILED}
        assert "down" not in json.dumps(events, ensure_ascii=False)
        assert logged == []


CAPS = [{"name": "send_email", "description": "メール送信", "inputSchema": {"type": "object"}}]


class TestPlan:
    def test_selects_capability(self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]) -> None:
        providers.anthropic.reply = json.dumps(
            {"capability_name": "send_email", "args": {"to": "x"}, "confidence": 0.9, "reasoning": "r"}
        )
        res = client.post(
            "/plan",
            json={"message": "tel 03-1234-5678 に送って", "org_id": "o", "available_capabilities": CAPS},
        )
        assert res.json() == {
            "capability_name": "send_email",
            "args": {"to": "x"},
            "confidence": 0.9,
            "reasoning": "r",
            "inferred_name": None,
            "pii_detected": True,
            "pii_types": ["PHONE"],
        }
        assert logged[0]["model"] == MODEL_HAIKU
        assert logged[0]["input_text"] == "tel [PII_PHONE] に送って"
        assert providers.anthropic.calls[0]["json_mode"] is True

    def test_logs_actual_model_after_degrade(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 上限超過で軽いモデルへ落ちたら、記録も落ちた後のモデル名にする
        async def _degraded(_org: str, _plan: str, _p: str, _m: str) -> tuple[str, str]:
            return "anthropic", "degraded-model"

        monkeypatch.setattr(router, "_degrade_if_over_limit", _degraded)
        providers.anthropic.reply = json.dumps({"capability_name": "send_email", "args": {}, "confidence": 0.9})
        client.post("/plan", json={"message": "m", "org_id": "o", "available_capabilities": CAPS})
        assert providers.anthropic.calls[0]["model"] == "degraded-model"
        assert logged[0]["model"] == "degraded-model"
        assert logged[0]["provider"] == "anthropic"

    def test_unknown_capability(self, client: TestClient, providers: Providers) -> None:
        providers.anthropic.reply = json.dumps({"capability_name": "nope", "args": {}, "confidence": 0.9})
        body = client.post("/plan", json={"message": "m", "org_id": "o", "available_capabilities": CAPS}).json()
        assert body["capability_name"] is None
        assert body["inferred_name"] == "nope"
        assert body["pii_types"] == []


class TestRank:
    def test_empty(self, client: TestClient, providers: Providers) -> None:
        assert client.post("/rank", json={"items": []}).json() == {"rankings": []}
        assert providers.anthropic.calls == []

    def test_fenced_json_and_fill_missing(self, client: TestClient, providers: Providers) -> None:
        providers.anthropic.reply = (
            '```json\n{"rankings":[{"id":"a","importance":"high","reason":"' + "x" * 80 + '"},'
            '{"id":"b","importance":"bogus"}, "junk"]}\n```'
        )
        items = [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}, {"id": "c", "title": "C"}]
        body = client.post("/rank", json={"items": items}).json()
        assert body["rankings"][0] == {"id": "a", "importance": "high", "reason": "x" * 60}
        assert body["rankings"][1] == {"id": "b", "importance": "mid", "reason": ""}
        assert body["rankings"][2] == {"id": "c", "importance": "mid", "reason": ""}

    def test_logs_and_counts_once(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]], counted: Any
    ) -> None:
        providers.anthropic.reply = '{"rankings":[{"id":"a","importance":"high","reason":"r"}]}'
        items = [{"id": "a", "title": "a@example.com 宛の見積"}]
        client.post("/rank", json={"items": items, "org_id": "o"})
        # AILog が1件予約され、利用量のキャッシュが1だけ進む（二重に数えない）
        assert len(logged) == 1
        assert logged[0]["org_id"] == "o"
        assert logged[0]["model"] == MODEL_HAIKU
        assert "a@example.com" not in logged[0]["input_text"]
        assert logged[0]["pii_detected"] is True
        assert counted() == 11

    def test_unparsable_reply_is_still_logged(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]
    ) -> None:
        providers.anthropic.reply = "not json"
        client.post("/rank", json={"items": [{"id": "a", "title": "A"}], "org_id": "o"})
        assert len(logged) == 1

    def test_llm_failure_falls_back_to_mid(self, client: TestClient, providers: Providers) -> None:
        providers.anthropic.error = RuntimeError("x")
        body = client.post("/rank", json={"items": [{"id": "a", "title": "A"}]}).json()
        assert body == {"rankings": [{"id": "a", "importance": "mid", "reason": ""}]}


class TestReceipt:
    def test_rejects_unsupported_media_type(self, client: TestClient, providers: Providers) -> None:
        body = client.post(
            "/vision/receipt", json={"image_base64": "AA", "media_type": "image/tiff", "org_id": "o"}
        ).json()
        assert body["notes"] == "対応していない画像形式です。写真で撮り直してください。"
        assert body["confidence"] == 0.0
        assert providers.anthropic.calls == []

    def test_rejects_too_large(self, client: TestClient, providers: Providers) -> None:
        big = "A" * ((5 * 1024 * 1024) * 4 // 3 + 8)
        body = client.post("/vision/receipt", json={"image_base64": big, "org_id": "o"}).json()
        assert body["notes"] == "画像が大きすぎます。もう少し小さいサイズで送ってください。"

    def test_provider_failure_returns_notes(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]
    ) -> None:
        providers.anthropic.error = ValueError("secret-in-message")
        body = client.post("/vision/receipt", json={"image_base64": "AA", "org_id": "o"}).json()
        assert body["notes"] == "領収書を読み取れませんでした。手入力で登録してください。"
        assert logged == []

    def test_success_logs_without_image(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]
    ) -> None:
        providers.anthropic.reply = json.dumps(
            {
                "amountIncludingTax": "1,100円",
                "taxAmount": 100,
                "incurredOn": "2026-11-01",
                "category": "MATERIAL",
                "confidence": 0.8,
            }
        )
        body = client.post("/vision/receipt", json={"image_base64": "AAAA", "org_id": "o"}).json()
        assert body["amountIncludingTax"] == 1100
        assert body["taxAmount"] == 100
        assert body["category"] == "MATERIAL"
        assert logged[0]["input_text"] == "[領収書画像]"
        assert logged[0]["model"] == "claude-sonnet-4-6"
        assert logged[0]["department"] == "ACCOUNTING"
        assert "AAAA" not in json.dumps(logged[0], ensure_ascii=False)


class TestPlanHttpNode:
    def test_secret_header_value_is_dropped(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]
    ) -> None:
        providers.anthropic.reply = json.dumps(
            {
                "name": "n",
                "http": {
                    "method": "GET",
                    "headers": [
                        {"name": "Authorization", "secret": True, "value": "leaked"},
                        {"name": "Accept", "value": "application/json"},
                        "junk",
                    ],
                },
                "params": [{"key": "q"}],
                "confidence": 0.7,
            }
        )
        body = client.post("/plan/http-node", json={"source": "curl https://x", "org_id": "o"}).json()
        assert body["http"]["headers"] == [
            {"name": "Authorization", "secret": True, "value": ""},
            {"name": "Accept", "secret": False, "value": "application/json"},
        ]
        assert body["department"] == "GENERAL"
        assert providers.anthropic.calls[0]["model"] == MODEL_OPUS
        assert logged[0]["model"] == MODEL_OPUS


class TestPlanAgent:
    def test_screen_first_rejects(self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]) -> None:
        providers.anthropic.reply = json.dumps({"repeatable": False, "confidence": 0.9, "reason": "雑談"})
        body = client.post("/plan/agent", json={"description": "d", "org_id": "o", "screen_first": True}).json()
        assert body == {
            "name": None,
            "department": "GENERAL",
            "instructions": None,
            "steps": [],
            "trigger": "MANUAL",
            "confidence": 0.0,
            "reasoning": "雑談",
        }
        assert providers.anthropic.calls[0]["model"] == MODEL_HAIKU
        # 判定も LLM 呼び出し1回なので記録する（以前は記録せず回数に入らなかった）
        assert len(logged) == 1
        assert logged[0]["model"] == MODEL_HAIKU

    def test_screen_counts_once(
        self, client: TestClient, providers: Providers, logged: list[dict[str, Any]], counted: Any
    ) -> None:
        providers.anthropic.reply = json.dumps({"repeatable": False, "confidence": 0.9})
        client.post(
            "/plan/agent",
            json={"description": "毎週 a@example.com に送る", "org_id": "o", "screen_first": True},
        )
        assert len(logged) == 1
        assert "a@example.com" not in logged[0]["input_text"]
        assert counted() == 11

    def test_designs_agent(self, client: TestClient, providers: Providers, logged: list[dict[str, Any]]) -> None:
        providers.anthropic.reply = json.dumps(
            {
                "name": "週報",
                "department": "SALES",
                "instructions": "i",
                "steps": [
                    {"capabilityName": "send_email", "argTemplate": {"to": "{{input}}"}},
                    {"capabilityName": "unknown"},
                    {"capabilityName": "llm_transform"},
                ],
                "trigger": "SCHEDULED",
                "confidence": 0.8,
                "reasoning": "r",
            }
        )
        body = client.post(
            "/plan/agent", json={"description": "d", "org_id": "o", "available_capabilities": CAPS}
        ).json()
        assert body["steps"] == [
            {"capabilityName": "send_email", "argTemplate": {"to": "{{input}}"}},
            {"capabilityName": "llm_transform", "argTemplate": {}},
        ]
        assert body["trigger"] == "SCHEDULED"
        assert body["department"] == "SALES"
        assert providers.anthropic.calls[0]["model"] == MODEL_OPUS
        assert logged[0]["department"] == "SALES"
        assert logged[0]["model"] == MODEL_OPUS
