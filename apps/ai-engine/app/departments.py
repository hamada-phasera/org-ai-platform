"""部署の一覧（AI Engine 内の唯一の定義）。

gateway の packages/shared-types `AGENT_DEPARTMENTS` と同じ並び。
並びはプロンプト（「配属可能な部署: ...」）にそのまま出るので変えないこと。
"""

from __future__ import annotations

from typing import Final

DEPARTMENTS: Final[tuple[str, ...]] = ("SALES", "MARKETING", "ACCOUNTING", "ANALYTICS", "GENERAL")

DEFAULT_DEPARTMENT: Final = "GENERAL"
