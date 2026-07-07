# 共有資産の変更要求（integration-requests）

> 各部署は `packages/shared/`（共有型・共通コード）を直接編集しない。
> 変更が必要になったら、このファイルに要求を追記してコミットし、ローカルモックで作業を継続する。
> オーガナイザー（統合エージェント）が `feat/integration` で対応し、人間承認後にマージする。
> 対応完了後、オーガナイザーは該当部署に「rebase してください」と進捗ボード経由で指示する。

## 記入フォーマット

```markdown
## #N [部署] 要求タイトル
- 要求日: 2026-07-XX
- 内容: 追加/変更したい型・インターフェースの具体内容
- 理由: なぜ共有化が必要か（どの部署が使うか）
- 暫定対応: どこにローカルモックを置いて作業継続しているか
- ステータス: 未対応 / 対応中 / 完了
```

---

<!-- 以下に各部署が追記する。番号は連番。 -->
<!-- 注: SNS ブランチ単独では他部署の採番が見えないため #S1.. で採番。統合(B)で連番へ再整理。 -->

## #S1 [SNS] SNSコンテンツの department/taskType タグ付け方針の確定
- 要求日: 2026-07-07
- 内容: 実装の `AgentDepartment` に **`SNS` は存在しない**（`SALES|MARKETING|ACCOUNTING|ANALYTICS|GENERAL`）。`department='SNS'` にすると DB は通るが `DEPT_LABEL`/`DEPT_ACCENT`/`DEPT_CHARACTER` が解決できず生表示になる。よって SNS 下書きは **`department='MARKETING'`（マーケ部）+ `taskType='sns'`** でタグ付けした（`taskType='sns'` は既存フロント `deliverableConstants` の `sns` レンダラが対応済み）。この方針で確定してよいか、分析部署の department 別KPIで SNS が MARKETING に混ざる点を許容するかを B/分析と確認したい。
- 理由: 「SNS を新設して shared-types/agents.ts/prisma を揃える」か「MARKETING に集約」かは横断決定。営業側 integration-requests の department 値域不一致とも連動。
- 暫定対応: `apps/api-gateway/src/routes/sns/posts.ts` で `SNS_DEPARTMENT='MARKETING'` / `SNS_TASK_TYPE='sns'` 定数化。
- ステータス: 未対応

## #S2 [SNS] 承認状態(Task.status)の共有化 + 配線要求
- 要求日: 2026-07-07
- 内容:
  - 承認フローを `status: 'PENDING_APPROVAL' → 'APPROVED' | 'REJECTED'`（終端・**dispatch/投稿なし**）で表現し、監査情報を既存の未使用列 `approvalData`（JSON `{state, reviewedBy, reviewedAt, reason?}`）に格納。`packages/shared-types` の `TaskStatus` は現状 `PENDING|RUNNING|DONE|FAILED` のみで、実コードで使う `QUEUED`/`PENDING_APPROVAL`/`APPROVED`/`REJECTED` が欠けている → 正式化を要望。
  - **重要**: 既存 `POST /tasks/:id/approve` は承認時に `dispatchQueuedTask()` で実行に回すため SNS では流用不可。SNS 専用の state-only エンドポイントを新設した。
  - **配線(B)**: フロント `App.tsx` に `<Route path="sns" element={<SnsPage/>} />`（`import SnsPage from './pages/SnsPage'`）+ ナビに「SNS」。API `index.ts` に `import { snsPostsRoutes } from './routes/sns/posts';` + `await app.register(snsPostsRoutes, { prefix: '/api/sns/posts' });`。
- 理由: 所有 vs 配線分離。承認状態は共有語彙なので shared-types 昇格が望ましい。
- 暫定対応: `routes/sns/posts.ts`（GET `/queue`, POST `/:id/approve`, POST `/:id/reject`）+ `SnsPage.tsx`（承認/却下UI）。登録前でも単体テスト済み(Vitest)。
- ステータス: 未対応

## #S3 [SNS→ガバナンス] AI Engine `/llm/chat` が AILog を記録しない（横断・再掲）
- 要求日: 2026-07-07
- 内容: `/llm/chat` は PII スクリーニングは通すが `log_llm_call` を発火しない（`/plan` 等のみ）。SNS 下書き生成もこの経路のため、`prisma.aILog.create` を呼び側で補完した。`/llm/chat` 側で集中ロギング（riskScore/RiskEvent 込み）にするのが望ましい。※営業ブランチでも同一課題を起票済み（統合で重複統合を）。
- 理由: 各部署での AILog 個別実装は重複・記録漏れの温床。
- 暫定対応: `routes/sns/posts.ts` で best-effort に `prisma.aILog.create`（riskScore は null）。
- ステータス: 未対応

## #S4 [SNS] 予約日時(scheduledAt)の第一級カラム化
- 要求日: 2026-07-07
- 内容: コンテンツカレンダー(N-3)は下書きを「日付」にひも付けて表示する。`Task` に予約日時カラムが無いため、暫定で**下書き output JSON 内の任意フィールド `scheduledAt`（ISO文字列）**に格納し、未設定時は `createdAt` を日付キーに採用している（JST丸め）。**投稿予約の実行はしない＝表示・状態可視化のみ**。将来的に予約絞り込み/並べ替え/月跨ぎ集計を DB 側で効率化するなら、`Task.scheduledAt DateTime?`（＋`@@index([orgId, scheduledAt])`）の追加を要望。prisma は統合(B)所有のため本ブランチでは変更せず、output JSON でローカル先行。
- 理由: JSON 埋め込みは where 句で日付フィルタできず、件数増で N+1/全件パースになる。共有スキーマ側の第一級フィールド化が望ましい。
- 暫定対応: `routes/sns/posts.ts` PATCH `/:id/schedule`（output に `scheduledAt` 差し込み・status不変・投稿なし）+ `routes/sns/calendar.ts`（`extractScheduledAt`/`draftDateKey`/`groupDraftsByDate`, JST）+ `components/Sns/SnsCalendar.tsx`（月グリッド, 読み取り専用）。単体テスト済み(Vitest)。
- ステータス: 未対応
