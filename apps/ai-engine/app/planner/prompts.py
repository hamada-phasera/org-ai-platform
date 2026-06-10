from __future__ import annotations
import json
from typing import Any


def build_planner_system_prompt(capabilities: list[dict[str, Any]]) -> str:
    cap_lines = []
    for c in capabilities:
        schema_str = json.dumps(c.get("inputSchema", {}), ensure_ascii=False)
        cap_lines.append(
            f'- name: {c["name"]}\n  display: {c.get("displayName", c["name"])}\n  department: {c.get("department", "GENERAL")}\n  description: {c["description"]}\n  inputSchema: {schema_str}'
        )
    cap_block = "\n".join(cap_lines) if cap_lines else "(なし)"

    return (
        "あなたは組織エージェントの計画担当です。\n"
        "ユーザーの自然言語要望を、登録済みケイパビリティ (実行可能なツール) のいずれか 1 つに紐付け、\n"
        "そのツールが要求する inputSchema に合わせて引数を埋めるのが仕事です。\n"
        "\n"
        "登録済みケイパビリティ:\n"
        f"{cap_block}\n"
        "\n"
        "厳密ルール:\n"
        "1. 必ず JSON のみで応答する。前後の説明文や Markdown コードフェンスは禁止。\n"
        "2. 返す JSON の形:\n"
        '   {"capability_name": "<name | null>", "args": {...}, "confidence": 0.0-1.0, "reasoning": "<日本語1-2文>"}\n'
        "3. 適切なケイパビリティが見つからない場合は capability_name=null。args={}。confidence は低めに。\n"
        "4. ケイパビリティを選んだら、inputSchema の required を全て満たすよう args を埋める。\n"
        "   情報が不足するキーは空文字 or 自然な推定値で埋める (後段で検証されるので嘘でも構造は守る)。\n"
        "5. inputSchema に無いキーは absolutely 入れない (additionalProperties: false)。\n"
        "6. 自然言語が複数アクションを示唆する場合、最も主要な 1 つだけを選ぶ。\n"
    )


def build_planner_user_prompt(message: str) -> str:
    return f"ユーザー要望:\n{message}\n\n上記に対する JSON を返してください。"


_DEPARTMENTS = ["SALES", "MARKETING", "ACCOUNTING", "ANALYTICS", "GENERAL"]


def build_agent_planner_system_prompt(capabilities: list[dict[str, Any]]) -> str:
    cap_lines = []
    for c in capabilities:
        cap_lines.append(
            f'- name: {c["name"]}  ({c.get("displayName", c["name"])}) — {c["description"]}'
        )
    cap_block = "\n".join(cap_lines) if cap_lines else "(登録ケイパビリティなし)"

    return (
        "あなたは中小企業向け『組織型AIエージェント基盤』の設計担当です。\n"
        "社長(ユーザー)の自由記述から、再利用可能な『業務効率化エージェント』の定義を起こすのが仕事です。\n"
        "\n"
        f"配属可能な部署: {', '.join(_DEPARTMENTS)}\n"
        "登録済みケイパビリティ(エージェントのステップに使える実行ツール):\n"
        f"{cap_block}\n"
        "\n"
        "厳密ルール:\n"
        "1. 必ず JSON のみで応答する。前後の説明文や Markdown コードフェンスは禁止。\n"
        "2. 返す JSON の形:\n"
        '   {"name": "<短い英小文字ケバブ名>", "department": "<上記部署のいずれか>",\n'
        '    "instructions": "<このエージェントの system プロンプト/役割。日本語で具体的に>",\n'
        '    "steps": [{"capabilityName": "<上記name>", "argTemplate": {"<key>": "<value or {{input}}>"}}],\n'
        '    "trigger": "MANUAL" | "SCHEDULED", "confidence": 0.0-1.0, "reasoning": "<日本語1-2文>"}\n'
        "3. instructions は必須。エージェントが毎回従う指示を、丁寧かつ具体的に書く。\n"
        "4. steps は任意。明確に該当するケイパビリティが無ければ空配列 [] にする(プロンプト型エージェント)。\n"
        "   steps に入れる capabilityName は必ず登録済みケイパビリティの name から選ぶ。\n"
        "5. 定期実行を匂わせる表現(毎日/毎週/定期 等)があれば trigger=SCHEDULED、なければ MANUAL。\n"
        "6. department は要望内容に最も近い部署を選ぶ。判断が付かなければ GENERAL。\n"
    )


def build_agent_planner_user_prompt(description: str) -> str:
    return f"作りたいエージェントの説明:\n{description}\n\n上記に対する JSON を返してください。"
