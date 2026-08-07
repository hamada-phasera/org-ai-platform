# 次期構想 v2 の精査結果（2026-08-06）

> 対象: 「1つのハーネス＋n8n内の有界な自己改善＋ノーコード意図組み立てUI」構想書 v2。
> 方法: ①実コードとの接地確認 ②外部主張の web 裏取り ③既存設計
> （[architecture-execution-kernel.md](./architecture-execution-kernel.md) / [roadmap-2026-08.md](./roadmap-2026-08.md)）との突合。

## 総合判定

**骨子は採用。** 方式(2)（検証済み部品の動的合成）・有界な自己改善・意味層は、
既存設計と独立に同じ結論へ到達しており、互いの検算になっている。
ただし**事実誤認 5 件と、既存設計にしか無い安全要件 4 件**があり、そのまま実施してはいけない。

## 1. 収束点（構想書 ≈ 既存設計。独立に同じ結論）

| 構想書 v2 | 既存設計 | 備考 |
|---|---|---|
| 方式(2) 検証済み部品の動的合成 / 方式(1) 実行時生成の排除 | Plan-as-Data + FLOW Runner（L3）/「実装の動的性」の例外化 | **完全一致** |
| 機械的検算 → 根拠照合 → 審査役LLM のカスケード（D章） | FactSet + Verify Gate（決定論的照合を主、LLM判定は従） | 一致。カスケード順も同じ |
| スキル台帳（部品＋説明文） | Job Template Registry（slots/sources/output/verify） | 同一物。**意味層の4項目型づけ＝JobTemplate.sources の正式化** |
| 意図カード1枚→クリック修正→実行（E-5） | 実行前プレビュー＋聞き返し最大1回フォーム | 同一 UX |
| 202即返し→非同期→コールバック | 現行 `dispatchAgentTask`（201+taskId→コールバック）が既にこの形 | 新規実装ではなく**補強**が正しい |
| 予算上限（周回/時間/費用）＋安全既定値へ退避 | 有界化・承認ゲート・D2（実投稿は明示解放のみ） | 一致 |

## 2. 構想書が新しく足すもの（既存設計に無い・価値あり）

- **G章 意味層** — 最大の追加価値。JobTemplate の sources 宣言を「業務概念⇔DB⇔スキル」の共通語彙に昇格させる。→ 実施済み第1版: [semantic-layer.md](./semantic-layer.md)
- **B章 ACE型戦術帳** — テナント別の学び（差分更新・剪定・版管理）。P2後半から stub（追記専用 JSONL）で開始し、grow-and-refine は後づけ。
- **E章 ノーコード・ハーネス組み立てUI** — 卒業演習の新規性の核。実装は React Flow。
- **MCP Server Trigger によるスキル公開** — 現行の webhook 直叩きより筋が良い。ただし後述の注意。
- **キューモード** — 現行 Render 単一インスタンスでは未対応（Redis 追加が必要）。9-10月の VPS/Cloud 移行判断と束ねる。

## 3. 事実誤認・要修正（5件）

| # | 構想書の記述 | 実際 | 影響 |
|---|---|---|---|
| 訂正1 | C章「Render無料はスリープする。有料化を」 | **2026-08-06 に3サービスとも starter 化済み・Supabase(us-west-2) 移行済み**。また「永続ディスク必須」は不正確 — n8n の状態は Postgres `n8n` スキーマにあり、ディスクが要るのはバイナリデータのみ | C-1 の対策は概ね完了済み。前提を更新して読む |
| 訂正2 | G章「18テーブルへの直SQL生成が温床」 | **現行コードに text-to-SQL は存在しない**（DB アクセスは全て Prisma の固定クエリ）。意味層は「既存の穴を塞ぐ」ではなく「これから入れる DB 参照生成を最初から安全に作る」層 | 主張はむしろ強くなる（後付け矯正より安い）。因果の記述だけ直す |
| 訂正3 | A-2「n8n MCP の更新は全体構造を丸ごと・部分更新不可」 | v2.14.0 の update ツールは**部分更新のバッチ（atomic）に対応**。n8n は 2.18.4+ を推奨（[n8n blog](https://blog.n8n.io/n8n-mcp-server/), [docs](https://docs.n8n.io/connect/connect-to-n8n-mcp-server/mcp-server-tools-reference)） | 「開発時専用」の結論は**維持**（クライアント別スコープ不可は変わらず）。制約の記述だけ更新 |
| 訂正4 | G-2「dbt 2026: 層の範囲内は最新2モデルとも100%、生テーブル直は64.5%」 | 一次資料では **GPT-5.3-Codex 100% / Claude Sonnet 4.6 98.2%**、生テーブルは **84〜90%帯**（モデル化済み設定）（[dbt Developer Blog](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026)） | 方向は正しいが、卒業演習で引用するなら数字を原典に合わせる |
| 訂正5 | 「見積もり作成」を8月検証の課題に | **現スキーマでは金額入り見積は作れない**。Quote/QuoteLine/PriceBook/Customer が無く、現行の提案書テンプレは「価格は要お見積りとし確定値は書かない」と明記（`proposal-templates.ts:50`）。機械的検算（単価×数量）の対象データ自体が存在しない | **8月検証の先行条件としてスキーマ拡張（semantic-layer.md の GAP-2〜4）が必須**。ここが最大のスケジュールリスク |

## 4. 構想書に無いが、実施の前提になるもの（既存設計から補完）

構想書は「冪等性キー・再試行・補償」と書くが具体が無い。以下は
[roadmap P3 前提条件](./roadmap-2026-08.md)として確定済みのものを使う:

1. **n8n credential の org 分離** — MCP Server Trigger は**クライアント別スコープ不可**（構想書自身が指摘）なので、テナント分離は n8n 層では実現できない。ハーネス層で orgId を強制し、スキルは orgId を必須引数に取り、credential は org 命名規約＋解決時検証。**これ無しで外部連携スキルを公開してはいけない**
2. **taskId 単位のコールバック鍵**（HMAC + 期限 + 状態遷移ガード）— `resumeUrl` 方式でも同じ問題（URL を知る者は誰でも再開できる）があるため必須
3. **lease + attempts + dispatchId** — 202 非同期の「迷子と二重実行」対策。構想書の冪等性キーはこれで具体化する
4. **既定ブランチ是正 + db-keepalive** — 未実施のまま。**7日でDBが再停止する**。全ての前提

## 5. 引用の裏取り結果

| 引用 | 判定 |
|---|---|
| ACE arXiv:2510.04618（+10.6%/+8.6%、Generator/Reflector/Curator） | ✅ 実在確認（[arXiv](https://arxiv.org/abs/2510.04618), [SambaNova](https://sambanova.ai/blog/ace-open-sourced-on-github)） |
| MONA arXiv:2501.13011（DeepMind, 多段 reward hacking 防止） | ✅ 実在（訓練知識で確認） |
| Plan-and-Act arXiv:2503.09572 / Spider 2.0（ICLR 2025, 実企業で2割前後に急落） | ✅ 実在（訓練知識で確認） |
| Cube arXiv:2604.25149（4KB文書で +17.2〜23.2pt, McNemar p≤0.0015） | ✅ 実在確認（[arXiv](https://arxiv.org/pdf/2604.25149), [Cube blog](https://cube.dev/blog/why-semantic-layers-make-llm-analytics-reliable-a-paired-benchmark-across-three-frontier-models)）。ベースは46〜51%→68〜69% |
| dbt 2026 Benchmark Update | ⚠️ 実在するが数字に差（訂正4） |
| n8n v2.14.0 MCP 生成/更新 | ⚠️ 実在するが「部分更新不可」は誤り（訂正3） |
| Trace2Skill 2603.25158 / Harness-G 2607.27652 / 2604.11378 / 2604.20801 / 2603.17150 / 2605.24309 / IAL F1 0.72 / n8n Issue #13135・#16822・#14748 / Hetzner 38%値上げ | ❓ **未検証**（2026年・カットオフ後）。設計判断には使ってよいが、**論文で引用する前に必ず原典確認** |
| n8n キューモードベンチ（162req/s vs 23req/s）/ Render 15分スリープ / Tools Agent 統一 | ✅ 訓練知識・実測（今日のバナー）と整合 |

## 6. 実施順（roadmap への統合）

構想書の「次の一歩」を、既存 P0〜P3 に噛み合わせて再配列する:

```
済  P0-0 Render starter化 / P0-1 Supabase移行（DB側）
残  P0-2 既定ブランチ→main + Secrets登録   ← 未実施。7日で再停止する
────────────────────────────────────────
P1' スキーマ拡張: Quote / QuoteLine / PriceBookItem / Customer（GAP-2〜4優先）
    ＋ プラン上限の実強制（従来P1-2）
P2' 実行カーネル = 構想書の「ハーネス1周」
    - 意味層 v1（済: semantic-layer.md）を Intent Resolver と Fetch の文脈に注入
    - スキル3〜5個: fetch_deals / fetch_pricebook / compose_quote / verify_amounts / risk_check
      実装は既存 cap-*.json 形式のサブWF ＋ MCP Server Trigger 公開（Render WAF で
      SSE が通るかを最初に実測すること — 過去に Code ノードで 403 の前科あり）
    - Verify Gate（機械的検算→根拠照合）
    - チャット経路の是正（RAG を n8n 分岐より先に。非ストリーム経路の順序逆転バグ）
P3' 動的合成の本格化 + ACE戦術帳 stub + ノーコードUI（意図カード→キャンバス段階的開示）
    前提: §4 の 1〜3 を先に実装
────────────────────────────────────────
8月検証の最小セット: P0-2 + P1'スキーマ + P2'（戦術帳はstubでよい）
比較条件 2×2（意味層有無 × 戦術帳有無）は、両方をフラグで OFF にできる実装にする
```

## 7. スケジュール上の率直な評価

今日は 8/6。「8月の学生検証」までに必要なのは P0-2（30分）＋ P1' スキーマ（1-2日）＋
P2' 最小（スキル3個＋ハーネス1周＋検証ゲート、5-8日）。**タイトだが成立する**。
ACE 戦術帳の grow-and-refine・ノーコードキャンバス・キューモードは 9-10 月に送る。
逆に言うと、**8月にやらないことを先に決める**のがこの計画の要（構想書 Caveats の
「意味層は過剰設計に転びやすい」への実務的な答えでもある）。
