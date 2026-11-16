from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

DEPARTMENTS = ["SALES", "MARKETING", "ACCOUNTING", "ANALYTICS", "GENERAL"]

# キーワードベースの分類（LLM呼び出し不要 → レート制限回避）
_KEYWORD_MAP: dict[str, list[str]] = {
    "SALES": [
        "営業", "メール作成", "提案書", "見積", "顧客", "議事録", "商談",
        "スケジュール調整", "契約", "受注", "発注", "クライアント", "アポ",
        "テレアポ", "フォローアップ", "セールス", "売上目標",
    ],
    "MARKETING": [
        "SNS", "マーケティング", "広告", "キャンペーン", "コピーライティング",
        "ツイート", "instagram", "twitter", "tiktok", "投稿", "ブランド",
        "プロモーション", "バズ", "フォロワー", "リーチ", "インフルエンサー",
    ],
    "ACCOUNTING": [
        "経理", "会計", "請求書", "経費", "予算", "税務", "領収書",
        "月次レポート", "決算", "仕訳", "勘定", "損益", "貸借", "確定申告",
        "インボイス", "給与", "振込",
    ],
    "ANALYTICS": [
        "データ分析", "市場調査", "グラフ", "チャート", "KPI", "統計",
        "トレンド", "競合分析", "可視化", "ダッシュボード", "レポート分析",
        "数値", "指標", "分析して", "集計",
    ],
}


async def classify_intent(user_message: str) -> str:
    msg_lower = user_message.lower()
    scores: dict[str, int] = {dept: 0 for dept in _KEYWORD_MAP}
    for dept, keywords in _KEYWORD_MAP.items():
        for kw in keywords:
            if kw.lower() in msg_lower:
                scores[dept] += 1
    best = max(scores, key=lambda d: scores[d])
    if scores[best] > 0:
        logger.info("classify_intent: keyword match -> %s (score=%d)", best, scores[best])
        return best
    logger.info("classify_intent: no keyword match, falling back to GENERAL")
    return "GENERAL"
