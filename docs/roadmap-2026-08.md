# 実行ロードマップ 2026-08 — Supabase 移行 → 動的ワークフロー再採用

> 前提: `main` = `a891c26`（2026-07-26）。以降コミット無し。
> 本番は Neon 無料枠の compute 枯渇で停止したまま（2026-07-26 の `P1001`）と推定される。
> 設計の詳細は [architecture-execution-kernel.md](./architecture-execution-kernel.md) を参照。

---

## 0. 全体像

```
P0  本番を生き返らせる        … Supabase 移行 + リポジトリ衛生     （半日）
P1  在庫を溶かす              … PR #2 再構築 + プラン上限の実強制   （2〜3日）
P2  土台を直す                … 実行カーネル（意図→事実→検証）      （1〜2週）
P3  動的ワークフロー再採用    … 静的サブWF + Plan-as-Data Runner    （1〜2週）
```

**P0 を飛ばして P3 に行くことはできない。** DB が無ければ「DBを参照してハルシネーションを出さない」
という設計そのものが成立しないため。

---

## 訂正（2026-08-06・Render ダッシュボードの実機確認による）

本ドキュメントの初版は「Render 3 サービスは starter 化済み＝スリープしない」を前提にしていた。
**実機を見たところ、これは誤りだった。**

| | 宣言（`render.yaml`） | 実態（ダッシュボード） |
|---|---|---|
| plan | `starter` | **`Free`** ＋「free instance は無活動でスピンダウンする」バナー |

`5b4e4a9` は `render.yaml` に意図を書いたが、支払い方法未登録で実サービスへ適用されていない
（work-log Phase 10 の `Plan requires payment information on file` 400 がそのまま残っている）。

**この乖離は同日中に解消された**（ユーザーが支払い設定とプラン変更を実施 → P0-0）。
記録として残す理由は、**同じ乖離が二度起きているため**（`5b4e4a9` のコミットメッセージにも
「n8n がダッシュボードだけで starter に変えられ、`render.yaml` は free のままだった」とある）。
`render.yaml` の宣言をもって「そうなっている」と読まないこと。実機を見るまでは未確認として扱う。

一方で、同じ画面から**良い知らせも 2 つ**取れた:

- **リポジトリ張り替えは完了していた** — `hamada-phasera/org-ai-platform · main` を指している
  （`docs/hamada-phasera-canonical.md` の手順2は実施済み。`rewire` 不要）
- **本番は現在おそらく起動している** — イベント履歴が
  `Instance failed (exit 1)` ×4（7/31）→ **`Service recovered`（8/3 11:14）** と推移している。
  7/31 の exit 1 は `startCommand` の `prisma migrate deploy` リトライ全滅による意図した停止。
  Neon の無料枠は月初にリセットされるため、8/1 以降に DB が復活して起動できたと読める。

→ **緊急度は下がったが、期限は消えていない。** 7 月は 26 日で 100 CU-hrs を使い切った。
同じペースなら **8 月も 20 日前後で再び停止する**。移行の猶予は約 2 週間と見るべき。

---

## P0-0. Render を実際に starter へ上げる（P3 の前提）— ✅ 2026-08-06 実施

支払い設定とプラン変更をユーザーが実施済み。**これで P3 の前提が揃った。**

**残りの確認**（乖離を二度と起こさないため）:
- [ ] `npm run render:status` の `plan` 行が 3 サービスとも `starter`
- [ ] ダッシュボードに「free instance will spin down」バナーが出ていない

`render.yaml` も `plan: starter` なので、Blueprint 同期で戻ることはない。

**リージョン: `oregon`（US West）で確定**（2026-08-06 ダッシュボード確認）。
→ **Supabase も西海岸に置く。** シンガポール（`ap-southeast-1`）とは往復 170ms 前後の差になる。

---

## P0. 本番復旧（最優先・半日）

### P0-1. Supabase 移行の実行

手順そのものは [supabase-migration.md](./supabase-migration.md) に検証済みで揃っている。
ここでは **実行順・判断ポイント・戻し方**だけを定める。

#### 現行プロジェクト（2026-08-06 作成・MCP で検証済み）

| 項目 | 値 |
|---|---|
| name / ref | `org-ai-platform` / **`cshpzbnezqtmmwrywgpt`** |
| **region** | **`us-west-2`（Oregon）** — Render と同一リージョン ✅ |
| status | `ACTIVE_HEALTHY` |
| Postgres | 17.6 |
| `n8n` スキーマ | 作成済み ✅ |
| `public` のテーブル | 0 件（`supabase:setup` 待ち） |
| `vector` 拡張 | **未インストール ✅**（画面から有効化していない＝正しい状態） |

#### 破棄した旧プロジェクト（記録）

| 項目 | 実測値 |
|---|---|
| project ref | `ejrcmnebkjaliebfnuqg` |
| 作成日 | 2026-07-26 |
| **status** | **`INACTIVE`** — 7 日無活動で一時停止済み。DB は `connection timeout` |
| **region** | **`ap-southeast-1`（シンガポール）** — Render(oregon) から往復 170ms 前後 |

新環境で `supabase:setup` が通り、本番が新 DB で動くまでは削除しないこと（戻り道として残す）。

- **一時停止**: `db-keepalive.yml` が既定ブランチの問題（P0-2）で一度も発火しておらず、
  予防が機能しなかった。データは消えていないのでダッシュボードから復帰できる。
- **リージョン**: **Render は `oregon`（US West）で確定**（2026-08-06 ダッシュボード確認）。
  現プロジェクトはシンガポールにあり、**太平洋を挟んで往復 170ms 前後**。
  1 リクエストで DB に数回問い合わせるため、ダッシュボードや一覧画面で体感に出る。

→ **判定: このプロジェクトは使わない。西海岸で作り直す。**
  移行方針が「既存データは破棄して作り直す」なので、作り直しのコストはほぼゼロ。
  Supabase のリージョン選択に `Oregon` があればそれを、無ければ **`West US (North California)` / `us-west-1`**
  を選ぶ（同一海岸なので往復 20ms 前後に収まる）。
  旧シンガポールプロジェクトは、新プロジェクトで疎通確認が取れてから削除する。

#### 事前準備（作業前に手元に用意する）
| # | 用意するもの | 入手先 |
|---|---|---|
| 0 | **Render のリージョン** | `npm run render:status` の `region` 行（本コミットで表示を追加） |
| 1 | Supabase アカウント | https://supabase.com |
| 2 | `RENDER_API_KEY` | Render → Account Settings → API Keys |
| 3 | 現行 Render env のバックアップ | `npm run render:status`（値は表示されないのでダッシュボードで控える） |

> **リージョンが一致しない場合はプロジェクトを作り直す。**
> 本移行は「既存データは破棄して作り直す」方針のため、作り直しのコストはほぼゼロ。
> 直すなら移行前が最も安い。一致していれば既存プロジェクトを復帰させてそのまま使う。

> ⚠️ **この作業は開発コンテナからは実行できない。** `api.render.com` / `supabase.com` ともに
> ネットワークポリシーで到達不可。**手元のマシン**で実行すること。

#### 実行順（各ステップに「止まる条件」を付ける）

```
1. Supabase プロジェクト作成
   └ ⛔ リージョンは **西海岸**（Oregon が無ければ West US / North California）
      Render が oregon なので、ここを間違えると全クエリに往復レイテンシが乗り続ける
   └ ⛔ Database Extensions で vector を有効化しないこと
      （有効化すると extensions スキーマに入り、マイグレーションが P3018 で落ちる）
   └ 作成後、.mcp.json の project_ref を新しい ref に差し替える

2. SQL Editor で:  CREATE SCHEMA IF NOT EXISTS n8n;

3. Connect → **Session pooler** の接続文字列をコピー
   └ ⛔ ホストが pooler.supabase.com か（db.<ref>.supabase.co は IPv6 のみ = Render から到達不能）
   └ ⛔ ポートが 5432 か（6543 の transaction モードは prisma migrate が必ず失敗する）
   └ 末尾に ?sslmode=require を付ける

4. 手元で疎通と事前検査:
     export DATABASE_URL='...'
     npm run supabase:check      # 読み取りのみ。接続文字列の罠を弾く
   └ ⛔ ここで落ちたら 3 に戻る。Render を触る前に必ず通す

5. スキーマ構築:
     npm run supabase:setup      # migrate deploy + n8n スキーマ + RLS 一括
   └ 期待: 全テーブル + pgvector が public に作成され、RLS が全テーブルで有効

6. Supabase の Settings → API で **Data API を無効化**
   └ ⛔ ここを飛ばすと User.passwordHash が anon キーで読める。必須

7. Render env 差し替え（3サービス）
     gateway   : DATABASE_URL（session pooler）/ GEMINI_API_KEY（RAG 埋め込み用に追加）
     ai-engine : DATABASE_URL（同じ文字列）
     n8n       : DB_POSTGRESDB_HOST / USER / PASSWORD / SCHEMA=n8n（pooler ホストを指定）

8. npm run render:deploy → npm run render:verify

9. GitHub Secrets に DATABASE_URL を登録（db-keepalive 用）
```

#### 受け入れ条件（[supabase-migration.md](./supabase-migration.md) の確認表 11 項目に加えて）
- [ ] `select '[1,2,3]'::vector;` が通る（vector が `public` にある）
- [ ] `rls_disabled` が 0 件
- [ ] anon キーでの `/rest/v1/User` が 404 か空
- [ ] 別セッションをまたいだ RAG 参照が効く（埋め込みが実際に書かれている）

#### ロールバック
Neon プロジェクトを消さずに残しておけば `DATABASE_URL` を戻して再デプロイするだけ。
**戻す場合は GitHub Secrets の `DATABASE_URL` を必ず削除する**（Neon の compute を起こして枠を焼く）。

---

### P0-2. リポジトリ衛生（Supabase と同じ日にやる）

**GitHub のデフォルトブランチが `feat/n8n-per-department`（6月のコード）のまま。**
Actions に登録されているワークフローは `keepalive.yml` 1本だけで、
**`db-keepalive.yml` は登録されていない = スケジュール実行が発火しない。**

スケジュール実行はデフォルトブランチからしか起動しないため、このままでは
Supabase に移行しても **7 日無活動でプロジェクトが一時停止し、本番がまた落ちる。**

| # | 作業 | 場所 |
|---|---|---|
| 1 | デフォルトブランチを `main` に変更 | GitHub → Settings → Branches |
| 2 | `db-keepalive` が Actions に現れることを確認 → 手動実行して緑になるか見る | Actions タブ |
| 3 | `keepalive.yml`（Render 向け ping）の `schedule` を停止 | starter 化でスリープしないため不要 |

---

## P1. 在庫の解消（2〜3日）

### P1-1. PR #2 を main ベースで作り直す

PR #2（open / draft / **conflicted** / 36ファイル / +2062行）には次スプリントの本体が入っている:
**n8n D1（生成系のTask化）・SNS段階1・KPIアラート・shared-types昇格・gemini単価0円**。

⛔ **そのままマージしてはいけない。** PR #3 が同じスキーマ変更を別名マイグレーションで
main に入れてしまっている:

| | マイグレーション名 | 入っている場所 |
|---|---|---|
| PR #2 | `20260716000000_add_deal_and_task_scheduled_at` | 未マージ |
| PR #3 | `20260724000000_add_deal_and_task_scheduled_at` | **main（マージ済み）** |

マージすると `Deal` テーブルの二重 `CREATE` で `prisma migrate deploy` が落ち、
gateway が起動不能になる（`P3009` で以降のデプロイも詰まる）。

**手順**: main から新ブランチを切り、PR #2 の差分を**マイグレーションを除いて**移植する。
移植対象を優先度順に分割し、1本ずつ小さく出す:

1. `gemini` 単価 0 円（`usage-metrics-svc/pricing.go` + 単価表）— 独立・低リスク
2. shared-types 昇格（型のみ。DB 変更は main に既に入っている）
3. KPI アラート（読み取り専用・cron）
4. 生成系の Task 化（D1）← P3 の前提になるので順番として最後でよい

### P1-2. プラン上限の実強制

`PLAN_LIMITS.aiCallsPerMonth` の参照は `routes/organizations.ts:86`（**表示のみ**）。
強制箇所がどこにも無く、さらに `/plan/agent` は全ユーザー Opus 固定。
= **STARTER の無料ユーザーが Opus を無制限に叩ける。**

- gateway の AI Engine 呼び出し前に当月 `AILog` 件数を見て 429 を返す共通フックを 1 本入れる
- `/plan/agent` の Opus 固定は admin と MAX に限定。STARTER/PRO は Gemini か Sonnet
- 上限の 80% でフロントに警告を出す（`UsageCard` が既にある）

---

## P2. 実行カーネル（1〜2週）

「チャットで意図を汲み、DB を参照し、ハルシネーションを出さない」を成立させる土台。
設計は [architecture-execution-kernel.md](./architecture-execution-kernel.md) に分離。

段階:
1. **FactSet + Verify Gate**（決定論的な事実照合）— ハルシネーション対策の本体
2. **Intent Resolver + Job Template Registry** — 一発目の質を担保するハーネス
3. 既存 `capability-resolver.ts` を Job Template に寄せる

---

## P3. 動的ワークフロー再採用（1〜2週）

### 有効化の前提条件（**満たすまで外部連携 capability を本番で開けない**）

| # | 条件 | 現状 | 理由 |
|---|---|---|---|
| 1 | n8n credential を **org 単位で分離** | ❌ グローバル1本 | A社のエージェントが B社の Google Drive に書ける |
| 2 | コールバックを **taskId 単位トークン**に | ❌ 全テナント共通・平文埋め込み | n8n を見られる人が全社のタスクを改竄できる |
| 3 | ディスパッチを **lease + attempts** で冪等化 | ❌ | 孤児タスク / 二重実行 |
| 4 | `workflowHash` による **self-healing** | ❌ | DB と n8n の二重真実（drift） |

### 段階
1. 静的サブワークフロー・ライブラリ（capability 1つ = サブWF 1本）
2. 汎用 Runner（Plan-as-Data。プランは DB、n8n は解釈器）
3. 動的生成は「Runner で表現できない例外」だけに限定

### starter 化で撤去してよくなったもの（可用性の配当・P0-0 完了により解禁）

- `task-executor.ts:304-315` の webhook リトライ `sleep` ループ（0/5/15秒）
  → HTTP ハンドラ内で `await sleep` しており、starter の 1 インスタンスを塞ぐ
- 「n8n起動中…」の TaskLog 演出
- `keepalive.yml`（Render 向け ping）— 既に `schedule` は停止済み

**ただし撤去は「n8n が実際に落ちない」ことを確認してから。**
リトライは元々コールドスタート対策だが、n8n の一時的な 502/503 も吸収している。
撤去するなら、代わりに §7 の lease + attempts + reaper を先に入れること
（リトライを消して回収の仕組みも無い状態が、いちばん危ない）。

**ただし D2（SNS 実投稿は段階2・明示解放のみ）は緩めない。**
これは可用性ではなく「不可逆な副作用」を理由にした判断なので、前提が変わっていない。

---

## 依存関係

```
P0-1 Supabase ──┬─→ P1-1 PR#2再構築 ──→ P2 実行カーネル ──→ P3 動的WF
P0-2 ブランチ ──┘                                              ↑
                        P1-2 プラン上限 ────────────────────────┘
                        （P3 で実行回数が増えるので先に入れる）
```
