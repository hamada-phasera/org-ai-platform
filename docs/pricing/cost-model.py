"""FLOW の原価モデル。単価を差し替えれば即再計算できるようにしてある。

トークン数は実測（プロンプトの文字数）から。日本語はおおむね 1文字 ≈ 1トークンとして扱う
（モデルにより 0.7〜1.5 の幅があるので、結論は幅で示すこと）。
"""

# ── 実測したプロンプトの大きさ（文字数） ─────────────────────
SYSTEM_PROMPT = 3_000      # 部署system(最大1,884) + 共通セキュリティ核(1,205)
RAG_BLOCK     = 9_600      # ファイル6件×1,200 + 過去メッセージ4件×600（RAGが効いたとき）
HISTORY       = 5_000      # 直近10件の抜粋（実測上限は1件12,000だが典型値）
USER_MSG      = 300

PLAN_AGENT_PROMPT = 8_000  # 固定450 + capability一覧 + 会話8件×800
PLAN_AGENT_OUT    = 800

CHAT_OUT_TYPICAL  = 1_200  # 回答の典型（上限は4,096）

def chat_turn_tokens(with_rag: bool):
    inp = SYSTEM_PROMPT + HISTORY + USER_MSG + (RAG_BLOCK if with_rag else 0)
    return inp, CHAT_OUT_TYPICAL

def cost(inp_tok, out_tok, in_price, out_price):
    """in_price / out_price は USD per 1M tokens"""
    return inp_tok / 1_000_000 * in_price + out_tok / 1_000_000 * out_price

if __name__ == "__main__":
    for rag in (False, True):
        i, o = chat_turn_tokens(rag)
        print(f"チャット1往復 {'(RAGあり)' if rag else '(RAGなし)'}: 入力 {i:,} / 出力 {o:,} トークン")
    print(f"エージェント化提案(Opus固定): 入力 {PLAN_AGENT_PROMPT:,} / 出力 {PLAN_AGENT_OUT:,} トークン")
    print()
    print("※ 単価が確定したら cost() に入れて計算する")
