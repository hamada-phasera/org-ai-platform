# Neon → Supabase 移行手順書

> 決定日 2026-07-26。**既存データは破棄**して作り直す方針（開発段階のテストデータのため）。
> データを残す場合は Neon が復旧してから `pg_dump` が必要なので、この手順書は使えない。

## なぜ移行するのか

Neon 無料枠は **compute 時間の従量制**（100 CU-hrs/月）で、24 時間稼働させると
最小の 0.25 CU でも `0.25 × 24 × 730 ≒ 180 CU-hrs` となり**構造的に枠内に収まらない**。
2026-07-26 に実際に枠を使い切り、compute が起動できず本番が `P1001` で停止した。

Supabase 無料枠は**小さいインスタンスが常時稼働**し、**7 日間"無活動"のときだけ**一時停止する。
常時稼働構成なら活動が途切れないため停止せず、こちらの方が構造的に合っている
（停止対策は `.github/workflows/db-keepalive.yml` で予防済み）。

## 前提: Render と Supabase の役割

置き換えではなく別の階層。**アプリは Render のまま**で、DB だけ差し替える。

```
【現在】  Vercel(web) → Render(gateway / ai-engine / n8n) → Neon(DB)
【移行後】 Vercel(web) → Render(gateway / ai-engine / n8n) → Supabase(DB)
                         ↑ ここは変えない                    ↑ ここだけ交換
```

「Render の env を差し替える」とは、Render 上のアプリに新しい DB の住所（`DATABASE_URL`）を教える作業。

---

## ⚠️ 事前に知っておく落とし穴（検証済み）

### 1. vector 拡張を Supabase の画面から有効化しないこと

Supabase は拡張を `extensions` スキーマに置く。その状態だと:

1. マイグレーションの `CREATE EXTENSION IF NOT EXISTS vector;` が **NOTICE で素通り**（エラーにならない）
2. マイグレーションは**成功**と表示される
3. デプロイも成功し、アプリも起動する
4. **RAG だけが実行時に `ERROR: type "vector" does not exist` で静かに壊れる**

**対策: 何もしないこと。** 拡張を事前に有効化しなければ、マイグレーションが `public` スキーマに
作成し、コード変更ゼロで正常動作する（実 PostgreSQL 16 で確認済み）。

もし既に `extensions` に作ってしまった場合は、接続文字列に
`?options=-csearch_path%3Dpublic,extensions` を足せば解決するが、ai-engine 側（asyncpg）で
追加対応が要る可能性があるため、**作り直す方が早い**。

### 2. n8n は専用スキーマに隔離する

n8n は起動時に約 40 テーブルを自分で作る。`DB_POSTGRESDB_SCHEMA=n8n` を指定すれば
`n8n` スキーマに隔離され、アプリの `public` と混ざらない。
テーブル名は衝突しない（n8n は `snake_case` / アプリは `"PascalCase"`）が、
隔離しておくと `DROP SCHEMA n8n CASCADE` で n8n だけ作り直せる。

### 3. マイグレーションは direct 接続で行う

Supabase には 2 つの接続経路がある。Prisma の `migrate deploy` は
**セッションを張る direct 接続（5432）**が必要で、transaction pooler（6543）では失敗する。

---

## 手順

### 1. Supabase プロジェクト作成
1. https://supabase.com でプロジェクト作成
2. リージョンは Render に近いところ（Render が us-east なら `East US` 等）
3. **Database Extensions で `vector` を有効化しない**（上記の落とし穴 1）

### 2. n8n 用スキーマを作成
Supabase の SQL Editor で:
```sql
CREATE SCHEMA IF NOT EXISTS n8n;
```

### 3. 接続文字列を 2 種類控える
Supabase の **Connect** から取得する。

| 用途 | 経路 | 使う場所 |
|---|---|---|
| マイグレーション | **direct**（ポート 5432） | Render gateway の `DATABASE_URL` |
| アプリの通常接続 | pooler（ポート 6543）でも可 | 同上（迷ったら direct 一本で問題ない） |

> gateway は起動時に `prisma migrate deploy` を実行するため、**direct を含む URL を使うこと**。
> 迷ったら direct 一本で始めてよい。接続数が問題になったら pooler を検討する。

### 4. Render の環境変数を差し替え
`npm run render:status` で現状確認 → ダッシュボードまたは API で更新。

**org-ai-api-gateway**
| キー | 値 |
|---|---|
| `DATABASE_URL` | Supabase の direct 接続文字列 |
| `GEMINI_API_KEY` | RAG の埋め込み生成に必要（ai-engine と同じキーで可）**← 追加** |

**org-ai-ai-engine**
| キー | 値 |
|---|---|
| `DATABASE_URL` | 同上（AILog 記録用） |

**org-ai-n8n**
| キー | 値 |
|---|---|
| `DB_POSTGRESDB_HOST` / `DB_POSTGRESDB_DATABASE` / `DB_POSTGRESDB_USER` / `DB_POSTGRESDB_PASSWORD` | Supabase の値 |
| `DB_POSTGRESDB_SCHEMA` | `n8n` **← 追加** |

### 5. デプロイ
```bash
npm run render:deploy
```
gateway の起動時に `prisma migrate deploy` が走り、**全テーブルと pgvector が自動作成される**
（マイグレーションは追加操作のみで、まっさらな DB / 既存データありの両方で検証済み）。

### 6. セキュリティ設定（RLS と Data API）— **必ずやること**

Supabase は Neon と違い、**`public` スキーマを自動生成 REST API（Data API / PostgREST）で公開する**。
`anon` キーはブラウザに配る前提の**公開キー**なので、この経路が開いたままだと外部から
テーブルを直接読める可能性がある。このアプリの `public` には次の列がある:

| テーブル.カラム | 漏れた場合 |
|---|---|
| `User.passwordHash` | **致命的**（パスワードハッシュ） |
| `User.email` | 個人情報 |
| `AILog.inputText` / `outputText` | 利用者の入力・AI応答（PII を含みうる） |

**対策は 2 つ。両方やる（多層防御）。**

**(a) Data API を無効化する** — このアプリは自動生成 API を一切使わない（ブラウザは必ず
Fastify gateway 経由で DB に触れる）。Settings → API から Data API を無効化するか、
公開スキーマから `public` を外す。これが最も確実。

**(b) 全テーブルで RLS を有効化する（ポリシーは作らない）**
```sql
-- public の全テーブルに RLS を有効化（ポリシー無し = 原則拒否）
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename); END LOOP;
END $$;
```

**アプリは壊れない。**実 PostgreSQL で検証済み:

| 接続元 | RLS 有効時の結果 |
|---|---|
| 所有者ロール（Prisma / gateway の接続） | **読める**（テーブル所有者は RLS をバイパスする） |
| `anon` 相当の別ロール | **0 件**（原則拒否が効く） |

> **RLS ポリシーは書かないこと。** RLS は本来 Supabase Auth の `auth.uid()` を前提とするが、
> このアプリは**独自 JWT** で認証し、テナント分離は gateway 側の `where: { orgId }` で行っている。
> `auth.uid()` は常に NULL なので、ポリシーを書いても意味を成さない。
> ここでの RLS は「Data API 経由の直アクセスを塞ぐ蓋」としてのみ使う。

> n8n を `n8n` スキーマに隔離してあるのも効いている。Data API が公開するのは既定で `public`
> だけなので、n8n のテーブルは最初から露出しない。

### 7. キープアライブを有効化
1. GitHub → Settings → Secrets and variables → Actions → **New repository secret**
2. 名前 `DATABASE_URL` / 値 Supabase の接続文字列
3. `.github/workflows/db-keepalive.yml` が 3 日ごとに `select 1` を実行し、
   7 日の無活動カウンタをリセットし続ける（到達不能ならジョブが赤くなって気付ける）

> シークレット未設定の間は何もせず終了するので、移行前に置いておいても無害。
> **Neon に戻す場合は必ずシークレットを削除すること**（compute を起こして無料枠を消費するため）。

---

## 移行後の確認

| # | 確認内容 | 期待 |
|---|---|---|
| 1 | `npm run render:verify` | gateway / ai-engine が 200 か 401 |
| 2 | 新規ユーザー登録 → ログイン | 成功（データは空から始まる） |
| 3 | チャットで質問 | 部署が自動判定され Gemini が応答 |
| 4 | **RAG 横断参照** | セッション A で「締切は毎月 18 日」等と伝え、**別セッション B** で聞くと答えられる |
| 5 | `/sales` で商談作成 → 再デプロイ後も残る | Deal テーブルの永続化 |
| 6 | `/sns` で下書き生成 → 承認待ちに入る | 自動投稿されないこと |
| 7 | SQL Editor で `select count(*) from "AILog";` | 1 以上（監査ログが記録されている） |
| 8 | SQL Editor で `select '[1,2,3]'::vector;` | エラーにならない（**落とし穴 1 の確認**） |
| 9 | n8n 管理画面が開く | `n8n` スキーマにテーブルが作られている |
| 10 | **RLS が全テーブルで有効か**（下記 SQL） | `rls_disabled` が 0 件 |
| 11 | **anon キーで直接叩けないこと**（下記 curl） | データが返らない（401 / 空配列） |

```sql
-- RLS が漏れているテーブルが無いか（0 件であること）
SELECT tablename AS rls_disabled FROM pg_tables t
WHERE schemaname = 'public'
  AND NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t.tablename)::regclass);
```

```bash
# anon キーで User テーブルを直接読めてしまわないか（Data API を無効化していれば 404）
curl -s "https://<project>.supabase.co/rest/v1/User?select=email" \
  -H "apikey: <anon key>" | head -c 200
```

### RAG が動かないときの切り分け
```sql
-- 拡張がどのスキーマにあるか（public であるべき）
select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector';

-- 埋め込みが保存されているか（0 なら索引されていない）
select count(*), count(embedding) from "MessageEmbedding";
```
- 拡張が `extensions` にある → 落とし穴 1。プロジェクトを作り直すのが早い
- 行が 0 → gateway に `GEMINI_API_KEY` が設定されているか確認（未設定だと RAG は静かに無効化される）

---

## ロールバック

Neon 側は消さずに残しておけば、`DATABASE_URL` を戻して再デプロイするだけで復帰できる
（ただし 8/1 の枠リセット後、かつ Supabase 移行後に作ったデータは戻らない）。
戻す場合は **db-keepalive のシークレットを必ず削除する**。
