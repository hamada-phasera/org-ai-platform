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

**この訂正が効く範囲**:
- **P3 の「撤去してよくなったリトライ `sleep`」は撤回。** `task-executor.ts:304-315` は**まだ必要**
- 「n8n が寝ていても全機能が成立する」という不変条件は**まだ有効**
- `keepalive.yml` の停止も、free のままなら**復活させるのが正しい**
- **動的ワークフロー再採用（P3）の前提が 1 つ増えた** → 下記 P0-0

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

## P0-0. Render を実際に starter へ上げる（P3 の前提）

宣言だけで実態が変わっていないので、課金設定から実施する。

1. Render → 支払い方法を登録
2. `npm run render:set-plan`（既定 starter。`render.yaml` と同値なので Blueprint 同期でも戻らない）
3. ダッシュボードで 3 サービスとも `Starter` 表示・スピンダウンのバナーが消えることを確認

**上がるまでは、P3（動的ワークフロー再採用）に着手しない。**
常時稼働を前提にした設計なので、free のまま進めると「n8n が寝ている間の穴」を作り込むことになる。

上げない判断をする場合は、逆に `keepalive.yml` の `schedule` を復活させ、
free 前提（リトライ sleep 維持・AI Engine フォールバック必須）で設計を固定する。
**どちらでもよいが、宣言と実態が食い違ったままにしない。**

---

## P0. 本番復旧（最優先・半日）

### P0-1. Supabase 移行の実行

手順そのものは [supabase-migration.md](./supabase-migration.md) に検証済みで揃っている。
ここでは **実行順・判断ポイント・戻し方**だけを定める。

#### 実測で判明したこと（2026-08-06・Supabase MCP 経由）

既に Supabase プロジェクトは存在する。ただし 2 点の問題がある。

| 項目 | 実測値 |
|---|---|
| project ref | `ejrcmnebkjaliebfnuqg`（`.mcp.json` に設定済み） |
| 作成日 | 2026-07-26 |
| **status** | **`INACTIVE`** — 7 日無活動で一時停止済み。DB は `connection timeout` |
| **region** | **`ap-southeast-1`（シンガポール）** |

- **一時停止**: `db-keepalive.yml` が既定ブランチの問題（P0-2）で一度も発火しておらず、
  予防が機能しなかった。データは消えていないのでダッシュボードから復帰できる。
- **リージョン**: 旧 Neon は `us-east-1`（`P1001` のエラーログより）、`render.yaml` に
  `region:` 指定が無いため Render は既定リージョン。**アプリと DB が別大陸だと全クエリに
  往復レイテンシが乗り続ける**（1 リクエストで数回問い合わせるため体感に出る）。

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
   └ ⛔ Database Extensions で vector を有効化しないこと
      （有効化すると extensions スキーマに入り、マイグレーションが P3018 で落ちる）

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

### starter 化したら撤去してよくなるもの（**P0-0 完了後**・可用性の配当）

> ⚠️ **2026-08-06 時点では実施不可。** 実サービスは `Free` のままでスピンダウンする（上記「訂正」参照）。
> P0-0 で実際に starter へ上がってから着手する。

- `task-executor.ts:304-315` の webhook リトライ `sleep` ループ（0/5/15秒）
  → HTTP ハンドラ内で `await sleep` しており、starter の 1 インスタンスを塞ぐ。
  ただし **free の間はコールドスタート対策として必要**なので残す
- 「n8n起動中…」の TaskLog 演出（同上）
- `keepalive.yml`（Render 向け ping）→ **free の間はむしろ `schedule` を復活させる**

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
