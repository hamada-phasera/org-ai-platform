# hamada-phasera を正準（本番）リポジトリにする手順 2026-07-08

> 目的: 現状の「作業=hamada-phasera / 本番デプロイ元=hamahiro1668(個人fork)」という分裂を解消し、
> **hamada-phasera/org-ai-platform を唯一の正準（コード＋デプロイ元）**にする。
> 本手順は**安定ネットワーク環境**で実施すること（このセッションのローカルは Vercel/Render/prod への到達が不安定）。

## 現状（このセッションで判明）
- **main が3系統に分裂**:
  - `hamada-phasera/main`（origin・作業repo）: keepalive/テスト等のみ・cycle-1統合なし。
  - `hamahiro1668/main`（prod・**現デプロイ元**・個人fork）: work-log 上は Phase8-10 稼働。**本セッションの `prod/main` ref (b3482e7) は古い可能性**（ネット不安定）。
  - **ローカル `main`（= 正準候補 `fd63f4e`）**: cycle-1統合 + Phase8-10 + origin/main の4コミットを**すべて内包**。
- Vercel `flow`（team=hamahiro1668s-projects, CLI駆動）＋ Render（3サービス, render.yaml）は **hamahiro1668 から**デプロイ。

## 正準候補（用意済み・push なし）
- `main = fd63f4e`。**origin/main(hamada-phasera) の完全上位集合**（`git rev-list --count fd63f4e..origin/main` = 0 → クリーンFF push 可能）。
- cycle-1（SalesPage/Analytics/Sns + 配線）・Phase8-10（dashboard/UI/n8n）・keepalive.yml すべて含む。

## ⚠️ 実施前の必須チェック（fork側の取りこぼし防止）
fork(hamahiro1668)側だけにあるデプロイ修正の有無が**不確か**。安定回線で確認・取り込み:
```bash
git fetch prod              # hamahiro1668
git rev-list --count main..prod/main   # >0 なら fork 側だけのコミットあり
git log main..prod/main --oneline      # 中身確認
# fork側だけのコミットがあれば取り込む:
git checkout feat/integration
git merge prod/main         # 衝突は work-log.md 程度の想定。解決して正準候補を更新
git branch -f main feat/integration
```
`main..prod/main` が 0 なら、ローカル main が prod を完全内包 → そのまま正準でOK。

## 手順
### 1. コード集約 → hamada-phasera/main を正準化
```bash
# 上の必須チェック後
git push origin main:main   # hamada-phasera/main を正準候補に更新（クリーンFFのはず。非FFなら停止して差分精査）
```
### 2. デプロイ連携を hamada-phasera へ張り替え（ダッシュボード）
- **Vercel `flow`**: Project Settings → Git → Connected Repository を `hamada-phasera/org-ai-platform` に、Production Branch=`main`。
  - もしくは CLI 運用継続なら、統合worktreeから `vercel deploy`（Preview）→ `vercel deploy --prod`。
- **Render（3サービス）**: 各サービス Settings → Repository を `hamada-phasera/org-ai-platform`、Branch=`main`、Auto-Deploy=On。
- **env は各サービスに紐づくため repo 変更で消えない**（Neon prod DATABASE_URL / ANTHROPIC_API_KEY / JWT_SECRET / N8N_* / EMBEDDING_* はそのまま）。ただし新規サービス作成で移す場合は render.yaml の `sync:false` キーを再設定。
### 3. デプロイ & 検証
- Render: hamada-phasera/main を Deploy（api-gateway/ai-engine/n8n）。prod Neon への `prisma migrate deploy` は冪等。usage-metrics-svc の `schema.sql`（rollupテーブル）適用。
- Vercel: 本番デプロイ。`FRONTEND_URL`（Render CORS）に Vercel 本番ドメインを含める。
- **本番スモーク**: register→ `/sales`(商談作成/遷移)→ `/sns`(下書き→承認)→ `/analytics`(部署KPI)→ 既存(agents/chat/dashboard)回帰。
### 4. 旧デプロイ元の退役
- 動作確認後、hamahiro1668(個人fork)からのデプロイを停止（Vercel/Render の旧連携を無効化 or サービス削除）。fork は保険として残すか削除は任意。

## 補足
- アカウント: Vercel CLI は hamahiro1668。flow が hamahiro1668s-projects 配下なら、team/所有権も hamada-phasera 側に寄せるか要検討（別途）。
- ローカルE2Eは合格済み（`docs/DEPLOY.md`）。コード品質はデプロイ可。
