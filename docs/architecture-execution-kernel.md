# 実行カーネル設計 — 意図を汲み、事実で答え、n8n が動く

> 目的: 「ユーザーがプロンプトを工夫する時間 > 自分で手を動かす時間」を無くす。
> 原則: **LLM は事実を作らない。事実は DB と実行結果からしか来ない。**
> 対象: FLOW を汎用 SaaS として成立させるための実行基盤の再設計。

---

## 1. 解くべき問題

いまチャット型 AI で業務をやると、こうなる:

```
人間: データを渡す
  ↓
人間: 「これどうしたらいい？」と聞く
  ↓
AI:   それらしい答えを返す（数字が微妙に違う / 前提が勝手）
  ↓
人間: プロンプトを工夫する … ①
  ↓
AI:   少し良くなる
  ↓
人間: ①に戻る（3〜10回）
  ↓
人間: 「自分でやった方が早い」
```

**ボトルネックは LLM の賢さではなく、①「人間がプロンプトを工夫している時間」。**
だからこの設計の目標は「もっと賢い AI」ではなく **「工夫しなくても一発目から使える足場（ハーネス）」**。

同時に、②「数字が微妙に違う」＝ハルシネーションが 1 回でも起きると、
ユーザーは**全部の出力を検算し始める**。検算コスト > 作成コストになった瞬間にツールは死ぬ。
だから精度は「高い」では足りず、**「構造的に混入しえない」**必要がある。

---

## 2. 最初に整理すべきこと — 「動的」には 2 種類ある

ここが今回いちばん大事な整理。

| | 意味 | ユーザーが欲しいもの | 事故の温床 |
|---|---|---|---|
| **(A) 振る舞いの動的性** | 依頼のたびに *やること* が変わる。分岐する。データに応じて手順が伸びる | ✅ **これ** | — |
| **(B) 実装の動的性** | 依頼のたびに *n8n のワークフローJSON* を新規生成して n8n に置く | 求めていない | ⚠️ こちら |

これまでの実装は **(B) で (A) を実現しようとしていた**。
その結果、エージェント 1 つにつき n8n の常設ワークフローが 1 本増え、
credential・トークン・drift・OOM の問題を全部抱え込んだ。

> **(A) は「プランをデータとして持つ」だけで達成できる。(B) は例外にしてよい。**

これが本設計の背骨です。詳細は §6。

---

## 3. 事故で痩せたもの — 何が失われたか

当初の n8n は「**考えて・分岐して・外部を叩いて・待つ**」役でした。
そこに 5 つの事故が順番に刺さり、削られ続けた結果、いまは「**受け取って・転送して・返す**」だけになっています。

### 事故の年表

| # | 時期 | 何が起きたか | 何を諦めたか |
|---|---|---|---|
| 1 | Phase 9 | Render の **WAF が Code ノード入りのWF生成を 403 でブロック** | **Code ノードを廃止**。ロジックは全部 gateway 側へ引き上げ、n8n には完成済み JSON（`llmBody`）を渡すだけに |
| 2 | Phase 9 | n8n が式内 `$env` をブロック（"access to env vars denied"） | 認証トークンを**生成時に平文で焼き込み**。→ 全テナント共通トークン問題の原因 |
| 3 | Phase 9 | コールバックが GET で飛び 404 | `method:'POST'` を明示（これは純粋な修正） |
| 4 | 2026-07-08 | n8n の **OOM インシデント** | `NODE_OPTIONS` でヒープ確保。ワークフロー数を増やしにくい体質に |
| 5 | 2026-07-26 | **Neon 無料枠の compute 枯渇 → 本番停止** | Supabase 移行へ（P0） |

さらに前提として、Render 無料枠は 15 分でスリープした。
そのため「**n8n が寝ていても全機能が成立すること**」を絶対条件にせざるを得ず、
n8n に重要な仕事を置けなくなった。これが決定的でした。

### 図で見る「痩せ方」

**当初の構想（n8n が主役）**

```
gateway ──webhook──▶ ┌─────────── n8n ワークフロー ───────────┐
                     │  Code: 意図を解釈                      │
                     │    ↓                                   │
                     │  Switch: 種類で分岐 ──┬── 提案書 ──┐   │
                     │                       ├── メール   │   │
                     │                       └── 分析     │   │
                     │    ↓                                │   │
                     │  Wait: 人間の承認を待つ ◀───────────┘   │
                     │    ↓                                   │
                     │  Google Docs / Slack / Gmail ノード     │
                     │    ↓                                   │
                     │  リトライ・エラー処理・デッドレター      │
                     └────────────────────────────────────────┘
```

**現在（事故のあと）**

```
gateway ──webhook──▶ ┌───── n8n ─────┐
  ↑                  │  Webhook      │
  │ ここで全部        │    ↓          │
  │ 考えている        │  HTTP Request │──▶ AI Engine /llm/chat
  │                  │    ↓          │
  └──── callback ────│  HTTP Request │
                     └───────────────┘
                        ＝ 郵便受け
```

**失われた 5 つの能力**

| 失ったもの | 何ができなくなったか |
|---|---|
| 🧠 **分岐** | データの中身に応じて手順を変えられない（Code/Switch が使えない） |
| ⏸ **待機** | 「人間の承認を待って続きを実行」ができない（承認は DB のフラグを見るだけの別処理に） |
| 🔀 **並列** | 「商談 100 件に個別メールを一斉生成」のようなファンアウトができない |
| 🔌 **コネクタ資産** | n8n が持つ 400+ の SaaS ノードをほぼ使えていない（Google Docs だけ例外的に生きている） |
| ♻️ **エラー処理** | リトライ・デッドレター・部分再開が n8n 側で完結しない |

**皮肉な結論**: 現状は **n8n のコスト（常設WF・credential・drift・OOM・WAF）を全額払いながら、
n8n の便益をほぼ受け取っていない。**
だから「動的ワークフローを再採用するか」ではなく、**「n8n を n8n として使い直すか」**が正しい問いです。

---

## 4. 実行カーネル — 7 層モデル

ハルシネーションを「起きにくくする」のではなく「**混入する経路を無くす**」ための構造。

```
① Intake       ユーザー発話 + 添付 + 組織コンテキストを正規化
      ↓
② Intent       何をしたいか を JSON で確定（Job Template を選ぶ）
      ↓        ← 足りない情報はここで「1回だけ」フォームで聞く
③ Plan         Job Template が実行DAGを宣言する（LLMは組まない）
      ↓
④ Fetch        DB / RAG / n8n読み取り から事実を取得 → FactSet を作る
      ↓        ← ここに LLM は一切介在しない（決定論的）
⑤ Compose      FactSet **だけ** を見て文章化。数値は必ず fact を引用
      ↓
⑥ Verify       出力中の数値・固有名詞が FactSet に在るか **機械的に照合**
      ↓        ← 不合格なら通さない
⑦ Act          副作用（Doc作成・メール下書き・投稿）は承認ゲートの後
```

### 4-1. 中核概念: FactSet

```ts
type Fact = {
  id: string;            // "f1", "f2" … 引用キー
  source: 'db' | 'rag' | 'n8n' | 'upload';
  origin: string;        // 'Deal.amount#clx123' / 'files/売上_2026Q2.xlsx:12行目'
  label: string;         // '2026年6月の受注金額合計'
  value: string | number;
  unit?: string;
};

type FactSet = { taskId: string; facts: Fact[]; query: string };
```

**FactSet は ④ Fetch でしか作られない。** LLM は FactSet を読むだけで、増やせない。

### 4-2. Verify Gate — 「一切出さない」の実体

LLM に「嘘をつくな」と頼むのではなく、**出力を機械的に検査して落とす**。

```ts
// 疑似コード
function verify(output: ComposedOutput, facts: FactSet): VerifyResult {
  const problems = [];

  // (1) 数値の出所チェック — 出力中の全数値トークンを抽出
  for (const n of extractNumbers(output.text)) {
    if (!facts.facts.some(f => matches(f.value, n))) {
      problems.push({ kind: 'UNGROUNDED_NUMBER', token: n });
    }
  }

  // (2) 引用の存在チェック — 主張ブロックには必ず cites が要る
  for (const s of output.sections) {
    if (s.kind === 'claim' && s.cites.length === 0) {
      problems.push({ kind: 'MISSING_CITATION', section: s.heading });
    }
  }

  // (3) 引用の実在チェック — 存在しない fact id を引いていないか
  for (const c of output.sections.flatMap(s => s.cites)) {
    if (!facts.facts.some(f => f.id === c)) {
      problems.push({ kind: 'DANGLING_CITATION', cite: c });
    }
  }

  return { ok: problems.length === 0, problems };
}
```

不合格時の振る舞い（**ここを決めておくことが重要**）:

```
1回目 不合格 → 問題箇所だけを指摘して自己修正させる（1回のみ）
2回目 不合格 → 該当箇所を「⚠️ データに根拠がありません」に置換して人間に出す
              （黙って通さない・黙って捨てもしない）
```

> LLM-as-judge ではなく**決定論的照合**を主にしているのが肝。判定自体が幻覚しない。

**日付・計算のような「派生値」の扱い**: 合計・前年比などは ⑤ Compose で LLM に計算させず、
④ Fetch の段階で SQL / コードで計算して Fact にする。**LLM に算術をさせない。**

### 4-3. これが「見やすいデータ分析」「営業メール」にどう効くか

**例: 「先月の売上、部署別で分析して」**

```
② Intent   → job_template = 'sales_analysis'
             args = { period: '2026-07', groupBy: 'department' }
③ Plan     → テンプレが宣言: [SQL集計 → グラフ仕様生成 → 所見文章化]
④ Fetch    → prisma.deal.groupBy(...) を実行
             FactSet = [ {f1, 営業部 受注額, 4,200,000}, {f2, マーケ部, 1,800,000}, … ]
⑤ Compose  → 「営業部が {{f1}} で全体の 62%（{{f1}}/{{total}}）を占め…」
⑥ Verify   → 4,200,000 は f1 にある ✅ / 62% は派生値として Fetch 済み ✅
⑦ 出力     → グラフ + 所見（各文に出典リンク）
```

**LLM が数字を「思い出す」余地がどこにも無い。** これが構造的な保証です。

**例: 「A社に見積のフォローメール」**

```
② Intent   → job_template = 'sales_followup_email', args = { dealId: ... }
④ Fetch    → Deal（金額・ステージ・最終接触日）+ 過去メール（RAG）+ 会社名
⑤ Compose  → 本文生成。金額・日付・担当者名は FactSet からのみ
⑥ Verify   → 本文中の「¥1,200,000」「7月18日」が Fact に在るか照合
⑦ Act      → Gmail 下書き作成（**送信はしない**。承認ゲート後のみ）
```

---

## 5. ハーネス設計 — 一発目のトークから質を担保する

「プロンプトを工夫する時間」を無くすための足場。**工夫を人間からシステムへ移す。**

### 5-1. Job Template Registry（業務の型）

few-shot 例をプロンプトに積むのではなく、**宣言として持つ**（few-shot は数が増えるとドリフトする）。

```ts
type JobTemplate = {
  id: 'sales_analysis' | 'sales_followup_email' | 'expense_report' | ...;
  label: string;                 // 「売上分析」
  department: Department;
  triggers: string[];            // 意図解決のヒント（「売上」「分析」「推移」）

  slots: Slot[];                 // 必要な引数と、それをどう埋めるか
  //   { name:'period', type:'month', required:true, default:'先月' }

  sources: SourceSpec[];         // ④ Fetch が何を取るか（宣言的・LLM は触れない）
  //   { kind:'prisma', model:'Deal', groupBy:['department'], aggregate:'sum:amount' }

  output: JSONSchema;            // ⑤ Compose の出力形（自由記述させない）
  verify: VerifyRule[];          // ⑥ Verify の追加ルール（必須スロット・単位・範囲）
  act?: CapabilityRef;           // ⑦ 副作用（あれば）。承認要否も持つ
};
```

**質が上がる理由**: プロンプトの良し悪しではなく、**「取るデータ」と「出力の形」と「検査基準」が
テンプレに固定される**から。ユーザーが何を書いても、通る道が同じ。

### 5-2. 聞き返しは「最大 1 回・フォーム形式」

チャットの往復（＝プロンプト工夫の時間）を構造的に禁止する。

```
発話 → Intent Resolver が {template, args, confidence, missing[]} を返す
   ├ missing が空 かつ confidence ≥ 0.7  → そのまま実行（聞き返さない）
   ├ missing がある                       → 足りないスロットだけを **フォーム** で提示
   │                                        （自由文の追加質問はしない）
   └ confidence < 0.5                     → 候補テンプレを 3 つ **選択肢** で提示
```

> 「何が知りたいですか？」と聞き返すのが最悪。ユーザーに言語化コストを戻している。
> **こちらが選択肢を出す。** 選ぶのは 3 秒、書くのは 3 分。

### 5-3. 実行前プレビュー（誤解の早期発見）

生成を始める前に 1 行で宣言する。

```
「2026年7月の受注データ（Deal 34件）を部署別に集計して、グラフと所見を作ります」  [実行] [変更]
```

間違った理解のまま 30 秒待たされるのが、体感品質を最も損なう。

### 5-4. モデル配分の見直し

現状は **エージェント構築(`/plan/agent`)だけ Opus 固定**で、他は plan 依存。これは配分ミス。

| 層 | 求められる能力 | 推奨 |
|---|---|---|
| ② Intent Resolver | **ここの精度が全体を決める。** 曖昧な発話 → 正しいテンプレ | **最良モデル**（Opus / 構造化なので出力は短く安い） |
| ④ Fetch | LLM 不使用 | — |
| ⑤ Compose | 日本語の質。事実は与えられている | 中位（Sonnet / Gemini flash） |
| ⑥ Verify | 決定論的照合が主。自己修正の1回だけ LLM | 中位 |
| エージェント構築 | 頻度が低い | Opus でよいが **admin / MAX に限定**（現状は全ユーザー = コスト攻撃面） |

**② に一番良いモデルを置くのが、体感品質あたりのコスト効率が最も高い。**
出力が JSON 数十トークンなので、Opus でも実コストは Compose より遥かに安い。

### 5-5. 出力形式の強制と自動修復

```
json_mode + JSON Schema 検証 → 不一致なら「スキーマ違反箇所だけ」を添えて 2 回まで再要求
                              → それでも駄目なら「テンプレ未対応」として素直に人間へ
```

### 5-6. 観測と還流

`AILog` に加えて **FactSet と Verify 結果を保存**する。
「なぜこの答えになったか」を後から再現でき、Verify の不合格パターンが
そのまま Job Template 改善のバックログになる。

---

## 6. n8n の再定義 — 3 層に分ける

### 6-1. どこに n8n を使うか

| 層 | 実行基盤 | 対象 | n8n の常設WF |
|---|---|---|---|
| **L1 純LLM実行** | AI Engine 直（gateway → `/llm/chat`） | 提案書生成・分析所見・チャット。**外部副作用なし** | **0本**（今ここに n8n を通しているのが最大の無駄） |
| **L2 外部連携** | n8n **静的サブWF**（capability 1つ = サブWF 1本） | Google Docs / Slack / Gmail / Sheets | capability 数だけ（十数本で頭打ち） |
| **L3 動的な手順** | n8n **汎用 Runner** がプランを解釈 | 分岐・並列・承認待ちを含む複合業務 | **1本**（Runner） |

**エージェントが 1000 個あっても n8n の常設ワークフローは L2+L3 の十数本のまま。**
これで #5 drift・#6 スケール・#1 credential のリスク面が同時に縮む。

### 6-2. Plan-as-Data — 「動的」をデータ側に持つ

```
【いままで】 エージェントごとに WF を生成して n8n に置く
   Agent A ──▶ n8n WF「agent-A」（常設）
   Agent B ──▶ n8n WF「agent-B」（常設）      ← 増え続ける・drift する・GC されない
   Agent C ──▶ n8n WF「agent-C」（常設）

【これから】 プランは DB、n8n は解釈器（インタプリタ）
   Agent A ─┐
   Agent B ─┼─▶ plan JSON ──▶ n8n WF「FLOW Runner」（常設1本）
   Agent C ─┘                      ├── Execute Workflow: cap-create_google_doc
                                   ├── Execute Workflow: cap-notify_slack
                                   └── Execute Workflow: cap-send_gmail
```

プラン（＝実行DAG）の形:

```json
{
  "planId": "pl_xxx", "taskId": "t_xxx", "orgId": "o_xxx",
  "steps": [
    { "id": "s1", "cap": "fetch_deals",       "args": { "period": "2026-07" } },
    { "id": "s2", "cap": "compose_analysis",  "needs": ["s1"] },
    { "id": "s3", "cap": "create_google_doc", "needs": ["s2"], "approval": "required" },
    { "id": "s4", "cap": "notify_slack",      "needs": ["s3"] }
  ]
}
```

利点:
- **Code ノード不要**（Execute Workflow ノードのみ）→ WAF 403 の再発リスクが消える（事故#1 の解）
- **常設WF が増えない** → OOM とコールドスタートの圧が減る（事故#4 の解）
- **drift しない** → プランは DB が真実の源のまま（盲点#5 の解）
- プランは**バージョン管理でき、差分レビューでき、テストできる**

### 6-3. それでも動的生成が要る場合

Runner の表現力を超えるもの（特殊なノード構成・特殊なトリガ）だけ、
従来の `buildChainedAgentWorkflowJson` 経路で生成する。**例外扱いにする。**
その際も前提条件（§7）を満たしていること。

---

## 7. 盲点の改善 — 何をどう直すか

### 🔴 #1 credential が全テナント共有

```
【いま】                          【あるべき】
n8n credential                    n8n credential
  └ "Google Docs" ×1                ├ "org:o_aaa / Google Docs"
      ↑                             ├ "org:o_bbb / Google Docs"
   全社のWFがこれを使う              └ "org:o_ccc / Google Docs"
   = A社がB社のDriveに書ける             ↑ 解決時に agent.orgId と一致検証
```

- credential 名に `org:<orgId>/` の規約を付ける
- `findProviderCredential(type)` を `findProviderCredential(type, orgId)` に変更し、
  **一致しなければ credential を埋め込まない**（＝そのステップは NEEDS_AUTH で止める）
- テストで「他 org の credential が解決されないこと」を固定する

### 🔴 #2 コールバックが共通トークン

```
【いま】   n8n WF に平文トークン（全テナント共通・全WF同じ）
             ↓
           POST /webhooks/n8n/task-complete { taskId, status, output }
             ↓
           taskId が合えば誰でも DONE にできる

【あるべき】 dispatch 時に taskId 固有トークンを発行
             callbackToken = HMAC(secret, taskId + dispatchId + expiry)
             ↓
           検証: HMAC 一致 + 期限内 + orgId 一致 + 状態遷移が合法
                 （DONE → DONE は拒否 = リプレイ防止）
```

### 🔴 #3 孤児タスク / 二重実行

```
【いま】 dispatch → n8n が 200 を返したら return
          → n8n がその後死ぬと Task は永遠に QUEUED/RUNNING（回収する仕組みが無い）
          → /n8n/queued-tasks は QUEUED を返すだけ（リース無し）＝ cron が二重に投げる

【あるべき】 Task に lease を持たせる（= 可視性タイムアウト付きキュー）
   Task { status, dispatchId, leaseUntil, attempts }

   dispatch: dispatchId を採番 / leaseUntil = now + 10分 / attempts++
   callback: dispatchId が一致するときだけ受理（古い実行の結果は無視 = 二重書き込み防止）
   reaper  : leaseUntil を過ぎた RUNNING を回収
             attempts < 3 → 再ディスパッチ / それ以上 → FAILED にして可視化
```

> これは「outbox パターン + 可視性タイムアウト」という定番の形です。
> 特別な発明ではなく、キューを自作すると必ず必要になる 3 点セット（lease / attempts / dispatchId）。

### 🟡 #4 リトライ sleep がプロセスを塞ぐ

starter 化で n8n が常時起動になったので、**このロジック自体が不要**。撤去する。

### 🟡 #5 drift（DB と n8n の二重真実）

L3 で動的生成を残す場合のみ発生する。`Agent.workflowHash` を持ち、
**実行直前に n8n 側のハッシュと突き合わせ、不一致なら再生成してから実行**（self-healing）。
Plan-as-Data に寄せた分だけ、この問題は自然に消える。

### 🟡 #7 Code ノードが 1 つ残っている

`buildChainedAgentWorkflowJson` の `Parse Args`。WAF 403 の再発リスク。
→ Plan-as-Data では Runner 側の静的サブWFに移るので消える。

### 🟡 #8 松竹梅が org 単位でしか効かない

n8n 経由の `llmBody` に `user_email` が乗らないため plan のみで判定。
→ プランに `actorEmail` を含め、AI Engine 側の判定に渡す（プランは gateway が署名して渡す）。

### 🟡 #9 RAG が静かに劣化する

- 埋め込み失敗（Voyage の 429 等）が **無言で null** → 根拠なしで普通に答えてしまう
  → 失敗を `FAILED` として記録し、**Verify Gate が「根拠ゼロ」を検出して止める**（④⑥で二重に防ぐ）
- `MessageEmbedding` に `model` 列が無く**再索引パスが存在しない** → 埋め込みモデルを変更できない
  → `model` / `dim` 列を足し、バックフィルジョブを用意する

---

## 8. n8n を「大いに活用する」ためのカタログ

L2/L3 に寄せ直すと、これらが現実的に使えるようになります。

| # | 使い方 | なぜ n8n が適任か | 効く場面 |
|---|---|---|---|
| 1 | **データ取り込みハブ**（Gmail/Drive/Sheets/Slack/kintone → FLOW の DB へ正規化） | 400+ コネクタの資産。認証・ページング・差分取得が既製 | **「人間がデータを渡す」作業そのものを消せる。** 本命 |
| 2 | **人間承認ゲート**（Wait ノード + Webhook resume） | 「止めて待つ」は n8n の本領。gateway で自作すると状態機械が増える | 見積送付・SNS投稿・請求書発行 |
| 3 | **並列ファンアウト** | 分割・並列・集約がノードで表現できる | 商談100件へ個別フォローメール一括生成 |
| 4 | **長時間ジョブ** | HTTP タイムアウトの外で回せる | 大量ファイルの索引・月次バッチ |
| 5 | **定期監視 → 閾値 → 通知** | schedule + 分岐が素直 | KPIアラート（PR#2 に実装済み） |
| 6 | **リトライ / デッドレター** | ノード単位リトライとエラーWFが既製 | 外部API の 429/503 |
| 7 | **双方向連携**（Slack/メールからの起票） | Trigger ノードが豊富 | Slack で「@FLOW 先月の売上」→ タスク化 |
| 8 | **ファイル変換パイプライン** | 変換ノード群 | PDF→テキスト→索引 |
| 9 | **顧客ごとの独自連携** | ノーコードで顧客個別要件を吸収 | SaaS としての「柔軟性」の源泉 |
| 10 | **サンドボックス実行** | 本体と分離した実行環境 | 顧客の書いた処理を本体から隔離 |

> #1 と #2 が、ユーザーの言う「時間がかかるからやめる」を最も直接に潰します。
> #9 が「汎用 SaaS としての柔軟性」の中核。**顧客ごとの差分を n8n のサブWFに逃がせる**構造にしておくと、
> 本体のコードを汚さずに個別対応ができる。

---

## 9. 段階導入

```
Step 1  FactSet + Verify Gate を既存のチャット/提案書経路に入れる
        └ n8n を触らずにハルシネーション対策が入る。効果が最も早く出る

Step 2  Job Template Registry（まず 3 つ: 売上分析 / 営業フォローメール / 経費集計）
        └ 「一発目の質」が体感で変わる

Step 3  L1 を n8n から外す（純LLM実行は AI Engine 直）
        └ 生成される常設WFが激減。#5/#6 のリスク面が縮む

Step 4  前提条件を実装（credential分離 → コールバック認証 → lease → reaper）
        └ ここを通るまで外部連携 capability は本番で開けない

Step 5  静的サブWFライブラリ + FLOW Runner（Plan-as-Data）
        └ ここで「振る舞いの動的性」が本格的に手に入る

Step 6  データ取り込みハブ（カタログ #1）と承認ゲート（#2）
        └ SaaS としての差別化はここから
```

各 Step は独立して価値が出るように並べてあります。途中で止めても損にならない順番。
