# ontology — 概念の定義と検査

`department` / `role` / `status` / `taskType` は DB enum ではなく String で持っている。
値の集合は shared-types と schema.prisma のコメントにしかなく、DB も TypeScript も 3 テーブル間の一致を保証しない。
ここはその「意味」を 1 箇所に置き、実データとズレていないかを機械的に検査する場所。

検査は決定的に行う（LLM を使わない）。LLM がやるのは新しい値を見つけたときの候補出しだけで、
既存概念の別表記として束ねるか、新しい概念として足すかは人が決める。

## 使い方

```bash
# 1. 観測（ontology/observe.sql を本番 DB で実行し、結果を observed.json に保存する）
#    本番は Supabase。Supabase MCP 経由で実行する（対象プロジェクトはダッシュボードで確認）。
#    ⚠️ 旧 Neon プロジェクトは 2026-07-08 で止まっている。測らないこと

# 2. 検証
npm run ontology:check       # error が 1 件でもあれば終了コード 1

# 3. 書き出し（SKOS + SHACL の Turtle。外部ツールや推論器に渡す用）
npm run ontology:ttl
```

出力は `ontology/out/`（git 管理外）に出る。`violations.md` / `graph.json` / `graph.html` の 3 点。

## ファイル

| ファイル | 役割 |
|---|---|
| `org.json` | 語彙の定義。**ここが真実の源**。Turtle は派生物 |
| `observe.sql` | 値の分布を取る読み取り専用 SQL |
| `observed.json` | 直近の観測結果（2026-09-13 時点） |

## CLAUDE.md の開発ルールとの対応

開発ルールの「すべての AI 入出力を AILog テーブルに記録する」は、
`department` スキームの coverage ルール（`Task.department` → `AILog.department`）が検査している。
2026-09-13 の実測では GENERAL / MARKETING / ACCOUNTING が AILog に 1 件も無く、このルールは守られていない。

## 直近の結果（2026-09-13、Supabase 実測）

error 0 / warn 1 / info 5。

- **`Task.department` に SALES があるのに `AILog.department` には無い。** 上の開発ルール違反。
  営業のタスクは動いているのに、その AI 実行が部署つきで監査ログに残っていない。

母数が小さいため（Task 5 件、User 1 件）、`DEAD_TERM`（語彙にあるが実データに0件）の判定は
`minSamples`（既定 20）のしきい値で省略している。info の `SMALL_SAMPLE` がそれ。
データが増えれば自動的に判定が始まる。

`Task.status` の `PENDING` は schema の default だが実データに 0 件のため、語彙では `deprecated` にしてある。
既定値を直すか語彙から消すかは未決。

## 注意: ドキュメントが実態とずれている（2026-09-13 時点）

CLAUDE.md / .env.example / DEPLOYMENT_RUNBOOK.md は本番 DB を Neon と書いているが、実際は Supabase に移行済み。
`.github/workflows/db-keepalive.yml` も「Neon 利用中は有効にしないこと」のまま止まっている。
Supabase の無料プランは 7 日間アクセスが無いと一時停止するので、本来は有効化する側の状態にある。
