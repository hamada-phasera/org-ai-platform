"""プロンプト組み立て（文字列の要点だけを固定する）。"""

from __future__ import annotations

from app.planner import prompts


def test_planner_system_prompt_lists_capabilities() -> None:
    out = prompts.build_planner_system_prompt(
        [{"name": "send_email", "description": "メール送信", "inputSchema": {"required": ["to"]}}]
    )
    assert "- name: send_email\n  display: send_email\n  department: GENERAL\n  description: メール送信" in out
    assert 'inputSchema: {"required": ["to"]}' in out


def test_planner_system_prompt_without_capabilities() -> None:
    assert "(なし)" in prompts.build_planner_system_prompt([])


def test_planner_user_prompt() -> None:
    assert prompts.build_planner_user_prompt("X") == "ユーザー要望:\nX\n\n上記に対する JSON を返してください。"


def test_format_params() -> None:
    schema = {
        "properties": {"title": {"type": "string"}, "rows": {"type": "array", "items": {"type": "array"}}, "n": None},
        "required": ["rows"],
    }
    assert prompts._format_params(schema) == "title:string, rows:array<array>(必須), n:string"
    assert prompts._format_params(None) == "なし"


def test_format_current_agent() -> None:
    assert prompts._format_current_agent(None) == ""
    out = prompts._format_current_agent(
        {"name": "a", "instructions": "i" * 500, "steps": [{"capabilityName": "x", "argTemplate": {"k": "値"}}, "bad"]}
    )
    assert '  1. x  引数: {"k": "値"}' in out
    assert "i" * 401 not in out
    assert "(手順なし)" in prompts._format_current_agent({"steps": []})
    assert "(手順なし)" in prompts._format_current_agent({"steps": ["bad"]})


def test_agent_planner_prompt_lists_departments_in_order() -> None:
    out = prompts.build_agent_planner_system_prompt([])
    assert "配属可能な部署: SALES, MARKETING, ACCOUNTING, ANALYTICS, GENERAL\n" in out
    assert "(登録ケイパビリティなし)" in out
    assert "【修正モード】" not in out


def test_agent_planner_prompt_with_capability_and_current() -> None:
    out = prompts.build_agent_planner_system_prompt(
        [{"name": "n", "displayName": "表示", "description": "説明", "inputSchema": {"properties": {"a": {}}}}],
        current_agent={"name": "cur", "steps": []},
    )
    assert "- name: n  (表示) — 説明\n    引数: a:string" in out
    assert out.rstrip().endswith("並べ替え後の順序で全部を返す。")


def test_other_builders() -> None:
    assert "『外部API呼び出しノード』" in prompts.build_http_node_system_prompt()
    assert prompts.build_http_node_user_prompt("SRC").count("SRC") == 1
    assert prompts.build_agent_screen_user_prompt("D").endswith("D")
    assert "repeatable" in prompts.AGENT_SCREEN_SYSTEM
