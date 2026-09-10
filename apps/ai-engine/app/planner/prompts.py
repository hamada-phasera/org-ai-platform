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


def _format_params(input_schema: dict[str, Any] | None) -> str:
    """inputSchema から 'title:string(必須), rows:array<array>(必須)' 形式の引数一覧を作る。

    これを渡さないとモデルは「配列が必要な引数」の存在を知り得ず、
    create_google_sheet / create_google_slides の argTemplate を必ず外す。
    """
    schema = input_schema or {}
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    parts: list[str] = []
    for key, spec in props.items():
        spec = spec or {}
        t = spec.get("type", "string")
        if t == "array":
            item_t = ((spec.get("items") or {}).get("type")) or "string"
            t = f"array<{item_t}>"
        parts.append(f"{key}:{t}{'(必須)' if key in required else ''}")
    return ", ".join(parts) if parts else "なし"


def _format_current_agent(current: dict[str, Any] | None) -> str:
    """既存エージェントを修正するときの現状ブロック。無ければ空文字。"""
    if not current:
        return ""
    steps = current.get("steps") or []
    if steps:
        lines = []
        for i, st in enumerate(steps, start=1):
            if not isinstance(st, dict):
                continue
            args = st.get("argTemplate") or {}
            lines.append(f'  {i}. {st.get("capabilityName")}  引数: {json.dumps(args, ensure_ascii=False)}')
        step_block = "\n".join(lines) if lines else "  (手順なし)"
    else:
        step_block = "  (手順なし)"
    return (
        "\n【修正モード】以下は既存エージェントの現状です。\n"
        f"名前: {current.get('name') or '(未設定)'}\n"
        f"指示: {(current.get('instructions') or '')[:400]}\n"
        "現在の手順:\n"
        f"{step_block}\n"
        "\n⚠️ 修正モードの厳守事項:\n"
        "- ユーザーが依頼した変更**だけ**を加え、それ以外の手順・引数は現状のまま残すこと。\n"
        "- steps は差分ではなく**変更後の完成形を全て**返すこと（返さなかった手順は消える）。\n"
        "- 手順の削除を頼まれたら、その要素を除いた残り全部を返す。\n"
        "- 並べ替えを頼まれたら、並べ替え後の順序で全部を返す。\n"
    )


def build_agent_planner_system_prompt(
    capabilities: list[dict[str, Any]],
    current_agent: dict[str, Any] | None = None,
) -> str:
    cap_lines = []
    for c in capabilities:
        cap_lines.append(
            f'- name: {c["name"]}  ({c.get("displayName", c["name"])}) — {c["description"]}'
        )
        cap_lines.append(f'    引数: {_format_params(c.get("inputSchema"))}')
    cap_block = "\n".join(cap_lines) if cap_lines else "(登録ケイパビリティなし)"
    current_block = _format_current_agent(current_agent)

    return (
        "あなたは中小企業向け『組織型AIエージェント基盤』の設計担当です。\n"
        "社長(ユーザー)の自由記述から、再利用可能な『業務効率化エージェント』の定義を起こすのが仕事です。\n"
        "\n"
        f"配属可能な部署: {', '.join(_DEPARTMENTS)}\n"
        "登録済みケイパビリティ(エージェントのステップに使える実行ツール):\n"
        f"{cap_block}\n"
        "- llm_transform (AIで文章を作る/要約する) — 予約ステップ。ケイパビリティ登録は不要で、\n"
        "  argTemplate.prompt に渡した指示を AI が実行し、その出力が次ステップの {{prev}} になる。\n"
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
        "   steps に入れる capabilityName は必ず登録済みケイパビリティの name か llm_transform から選ぶ。\n"
        "5. steps は上から順に実行される。argTemplate の値には次の 2 つだけ埋め込める:\n"
        "   {{input}} = 実行時の入力テキスト全体 / {{prev}} = 直前ステップの出力。\n"
        "   『まとめてから投稿する』のように加工が要る場合は、先に llm_transform で本文を作り、\n"
        "   次のステップでその {{prev}} を使う。必要な引数(channel 等)は具体値を書くこと。\n"
        "   例: [{\"capabilityName\": \"llm_transform\", \"argTemplate\": {\"prompt\": \"{{input}} を3行で要約\"}},\n"
        '        {"capabilityName": "notify_slack", "argTemplate": {"channel": "#general", "text": "{{prev}}"}}]\n'
        "6. 定期実行を匂わせる表現(毎日/毎週/定期 等)があれば trigger=SCHEDULED、なければ MANUAL。\n"
        "7. department は要望内容に最も近い部署を選ぶ。判断が付かなければ GENERAL。\n"
        "8. argTemplate に書けるキーは、そのケイパビリティの『引数』に列挙されたものだけ。必須引数は必ず埋める。\n"
        "9. array 型の引数は JSON 配列リテラルの文字列で書いてよい"
        '(例 "[[\\"日付\\",\\"売上\\"],[\\"4/1\\",100]]")。実行時に実体へ復元される。\n'
        + current_block
    )


def build_agent_planner_user_prompt(description: str) -> str:
    return f"作りたいエージェントの説明:\n{description}\n\n上記に対する JSON を返してください。"
