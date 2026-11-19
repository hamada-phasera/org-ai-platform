# ホームキャンバスと業務フロー レビュー

- 対象: `feat/canvas-home` の `git diff origin/feat/custom-pages...HEAD`（3116e85 まで、146 ファイル）
- 照合: `docs/design/canvas-home.md`（以下「設計書」）、`DESIGN.md`、`CLAUDE.md`
- 方法: コードを読んで確かめた（テスト・ビルドは回していない）。コードは変えていない
- 日付: 2026-11-19

## 結論

方式（自前キャンバス＋自前ランナー、n8n は `parts/<key>` の部品だけ）は設計書どおりに実装されている。ライセンス・SSRF・承認の強制停止・テンプレート式・テナント分離の柱はテストで固定されていて、大きな穴は無い。

**直してからマージしたいのは 1 件（高）**。フローの `minRole`（役割の制限）が、フローの Task と承認の経路で効いていない。オーナー限定のフローの外部送信を、メンバーが受信から承認できる。中の 4 件は、次のチャンクで直せば足りる。

## 指摘

| # | 重大度 | 場所 | 問題 | 直し方 |
|---|---|---|---|---|
| 1 | 高 | `apps/api-gateway/src/services/flows/queue.ts:356-363`（`approveFlowStep`）、`nodes/approval.ts:66`（送信前の承認の `minRole: 'MEMBER'` 固定） | 承認のとき、フローの `minRole` を見ていない。確かめているのは承認データの `minRole` だけで、送信前の承認は常に MEMBER、確認ノードも既定は MEMBER になる。そのため、オーナー限定（例: 経営数字）のフローの「送信前」の承認を MEMBER が受信から通せる。T15「閲覧・実行は minRole」と §7.4 の趣旨に反する | `approveFlowStep` / `rejectFlowStep` で `FlowRun.flowId` からフローを引き、`canViewFlow(flow, role)` を満たさなければ 404 にする。フローが消えていれば実行に写した定義の `minRole` を使うか、ADMIN 以上だけにする。承認に要る役割は `max(フローの minRole, ノードの minRole)` にする。テストを足す: オーナー限定のフローの送信前承認を MEMBER が叩くと 403/404 |
| 2 | 中 | `apps/api-gateway/src/routes/tasks.ts:44-76`（GET 一覧・単体）、受信の承認タブ、成果物、`tasks.ts:110`（PATCH）・`:269`（DELETE） | フローの実行と対になる `Task`（`taskType='flow'`）が、フローの `minRole` で絞られていない。MEMBER でもオーナー限定フローの入力・AI の出力・送信前のプレビュー（宛先・本文）・成果物を `/api/tasks`・受信・成果物で読める。さらに汎用の PATCH で `status` / `output` を書き換えられる（`QUEUED` にすると既存の `dispatchQueuedTask` が汎用タスクとして走らせる）。DELETE で承認待ちの Task を消すと、その実行は 7 日間宙に浮く | Task の一覧・単体・受信・成果物で、`taskType='flow'` の行は `FlowRun.taskId` → フローの `minRole` で絞る。または Task に `minRole` を写して既存の絞り込みに乗せる。`taskType='flow'` の PATCH（状態・出力）と DELETE は 409 `FLOW_MANAGED` で断る（`scheduled-tasks.ts` の `FLOW_MANAGED` と同じ形）。分離・権限のテストに足す |
| 3 | 中 | `apps/web/src/components/canvas/CanvasBoard.tsx:222`・`:266` | キャンバスの保存で、他の ADMIN の保存を黙って上書きする（lost update）。`startEdit` で写すのは配置だけで、保存のときの `baseVersion` には**その時点の** `data.version` を渡している。`useCanvas` は staleTime 30 秒で、フォーカスすると取り直す。編集中に取り直しが走ると版だけ新しくなり、古い配置が 409 にならずに通る（設計書 T18・§5.2 の楽観ロックが画面で無効になる） | 編集を始めたときの版を下書きと一緒に持ち（`{ layout, baseVersion }`）、保存ではそれを送る。再現テスト（編集中に版が上がる → 409 の表示）を足す |
| 4 | 中 | `apps/web/src/pages/FlowPage.tsx:49`（`key={id:version}`）、`components/flow/flowApi.ts:93`（`useFlow` は staleTime 0）、`OutputBuilder.tsx:75`（`key={page.version}`） | フローの編集中に版が上がると、エディタが作り直されて未保存の編集が黙って消える。版が上がるのは、他の人の保存、スマホからの文字の PATCH、フォーカスでの取り直し。設計書 §3.4 は 409 で知らせる決まり。出力ビルダーも同じ作り | 作り直しの key を「自分の保存が成功したとき」だけ変える。編集中（dirty）は外から来た版の変化で作り直さず、「他の人が更新しました」を 1 行出す。保存すれば 409 になる。または編集中は `refetchOnWindowFocus: false`。離れるときの警告（`beforeunload` / `useBlocker`）も足す |
| 5 | 中 | `docs/design/canvas-home.md` §5.4・T20／持ち越し C5-3 | 実行履歴（`FlowRun`）の保持期間の掃除が無い。`input` / `steps` / `output` に顧客の値が溜まり続ける。画面は `flowHistoryCutoff` で隠すだけ。§1.2 の G6（履歴の保持期間でプラン差）も実際には効かない | 日次の掃除（当月は消さない・プランの日数を過ぎた行を `deleteMany`。回収の tick と同じスイッチ）を入れてから本番で有効にする。少なくとも C5-3 を DoD の未達として明記する |
| 6 | 低 | `apps/api-gateway/src/routes/flows.ts:142`（`requestIdSchema`）、`services/schedule-dispatcher.ts`（`sched:<flowId>:<時刻>`） | 利用者の `requestId` に `sched:` で始まる値を送れる。次の時間帯の `sched:<flowId>:<hourStart>` を先に送ると、その時間の定期実行が `DUPLICATE_REQUEST` で断られる（同じ組織のメンバーなら定期を潰せる） | 利用者からの `requestId` は UUID の形に限る（`z.string().uuid()`）か、`sched:` で始まる値を拒否する |
| 7 | 低 | `apps/api-gateway/src/services/flows/nodes/data.ts:157-163`・`:184` | データノードの 5 秒のタイムアウトは `Promise.race` なので、DB の書き込みは止まらない。商談や原価（DRAFT）の create が遅れて成功しても、ノードは FAILED になる。人が「もう一度実行」すると二重に作られる | 書き込み（create / update）は `withTimeout` で打ち切らず、トランザクションの `timeout` に任せる。または FAILED の文言を「作成されたかもしれません。台帳を確認してください」にする |
| 8 | 低 | `apps/api-gateway/src/services/flows/queue.ts:208-249`、`limits.ts:89` | 上限は「数えてから作る」ので、同時の受け付けで月間実行数・QUEUED 20・フロー数を少し超えうる（業務ページと同じ水準）。承認後の再開（`approveFlowStep`）は組織の同時実行数を見ずに着手する | 許容なら設計書 §7.6 に「同時の受け付けで数件超えうる」と書く。再開も `pumpOrg` に積んで着手させる |
| 9 | 低 | `apps/api-gateway/src/routes/flows.ts`（POST `/:id/runs`） | T11 の「組織ごとの窓（業務ページの `org-throttle` を共用）」が実行に付いていない。IP ごと 30 回/分だけ | `takeOrgActionSlot(orgId, 'flow_run')` を受け付けの前に足す。足さないなら設計書を直す |
| 10 | 低 | `apps/api-gateway/src/services/flows/nodes/ai.ts:264-269`、`packages/shared-types/src/flows-core.ts`（`instruction` もテンプレート） | T4(b) の「指示とデータを分ける」が抜けられる。`instruction` に上流の値（`{{form.x}}`）を差し込めるので、その値が system に入る。資料の囲みも `</資料>` を値の中に書けば閉じられる。外部送信は承認で止まるので影響は限定的 | `instruction` で参照できるのを組み込み（`run` / `org`）だけにするか、差し込んだ値を user 側へ移す。資料の囲みの閉じタグを値から取り除く |
| 11 | 低 | `apps/api-gateway/src/routes/flows.ts:215-222`、`services/flows/store.ts:238-246` | テンプレートから作るとき、既存のフローが自分より上の役割限定なら 404 を返す。ところがその前に、キャンバスのノードの行き先を書き換えてしまう（存在の小さな漏れと、意図しない変更） | 既存が `canViewFlow` を満たさないときは、書き換えの前に 404 にする |
| 12 | 低 | `apps/api-gateway/src/routes/flows.ts:101-121`（PATCH の `node.config`）、`store.ts:452-467` | スマホの文字の変更（K76: ラベル・AI の指示・確認の文言・題名・本文・通知の本文だけ）が、サーバでは縛られていない。既存の文字項目なら `to`（宛先）・`left`・`rows`・`frequency` なども変えられる。ADMIN だけでスキーマも通すので危険は小さいが、設計との差分 | `applyNodeTextPatch` に型ごとの許可リスト（shared-types の `mobileTextFields`）を使う |
| 13 | 低 | `apps/web/src/pages/InboxPage.tsx:276` ＋ `components/exec-kernel/RunPreviewRow.tsx:36` | 受信のフロー承認がカードの入れ子になっている（枠＋影の中に枠＋影）。DESIGN の「カード入れ子禁止」に反する。既存のエージェント承認の作りを写したもの | 外側を区切り線の行にするか、`RunPreviewRow` に枠なしの変種を足す |
| 14 | 低 | `apps/web/src/pages/InboxPage.tsx:256`・`:293-299` | 受信のフロー承認で、(a) `flowApprovalsQ` の失敗が「承認待ちはありません」に見える。(b) 失敗の文言が固定で、402 や 409 の `error.message` を出さない。(c) 承認の mutation を全カードで共有していて、別のカードを押すと処理中の印が外れる。(d) 却下に処理中の印もエラー表示も無い（サーバは条件付き更新なので実害は表示だけ） | `isError` を両方見る。`apiErrorOf(...).message` を出す。処理中の id を Set で持つ。却下にも busy とエラーを付ける |
| 15 | 低 | `apps/web/src/components/canvas/CanvasBoard.tsx:327`、`flow/FlowEditor.tsx:374-379`、`flow/FlowMobile.tsx:44-52`・`:65` | 閲覧のみ（402）の組織でも「編集」「保存」「実行」がそのまま押せる（押してから帯と 1 行で知らせる）。スマホの「有効」切り替えには処理中の印が無く、PATCH が 2 本飛ぶ | `planNoticeStore` の readOnly でボタンを止めて理由を添える。スマホの切り替えに busy を付ける |
| 16 | 低 | `apps/web/src/components/canvas/BusinessList.tsx:40`、`HomeNode.tsx:44` | `aria-label="〇〇を開く"` が中身を上書きするので、「未作成」「次: 〇〇」「承認待ち N件」がスクリーンリーダーで読まれない（§3.6・K68） | aria-label を外して中身の文字で名前を付けるか、`aria-describedby` で補足を結ぶ |
| 17 | 低 | `apps/web/src/components/canvas/canvasApi.ts:82` | テンプレート作成の二重押しガード（`if (pendingId) return`）が古いクロージャの値を見ていて効かない。gateway は slug の一意制約で冪等なので実害は無い | `useRef` でガードする |

## 観点ごとの確認結果（問題なし・差分）

| 観点 | 結果 |
|---|---|
| ライセンス（D9・T22） | 問題なし。`services/flows/**` `routes/flows.ts` `routes/canvas.ts` は `n8n-workflow-builder` も `n8nApiKey` も `/api/v1/` も使わない（`architecture.test.ts` A6 で固定）。public API を読むのは、運営にだけ出す `services/n8n/part-editor.ts` の GET だけ（K60）。お客さんの操作で `/api/v1/` が 0 回であることも通しのテストがある（`flow-parts.route.test.ts:431`）。残りは既存の C6-4（`send_email` の資格情報チェックが credential 一覧を GET することがある） |
| SSRF（T6・T7） | 問題なし。URL は `buildPartUrl(config.n8nUrl, key)` だけで、key はもう一度正規表現で確かめる。POST・`redirect: 'error'`・JSON だけ・256KB まで。宣言した出力キーだけを受け取る。body の `orgId` は実行の組織で、B の実行は B を送る（テストあり）。キャンバスの `link` は内部パスの許可リスト |
| 承認（D5・T5・K12・K57・K62） | 送信の前で必ず止まり（定義に確認ノードが無くても、知らない部品でも）、承認は条件付き `updateMany` で 1 回だけ続く。止めた時点で展開した中身（gateArgs）をそのまま送る。確認ノードの直後でもう一度止まるのは K62・K72 の決定どおり。**権限は指摘 1** |
| フロー定義の検証 | 問題なし。zod は `.strict()`、ノード型は 7 種。DAG（Kahn 法）・到達・きっかけ 1 つ・分岐の線・出次数・上流だけの参照・予約語（`run` `org` `constructor` `prototype`、`__proto__` は正規表現で弾く）を見ている。`renderTemplate` は 1 回だけ展開し `hasOwn` で引く。ランナーは実行時にも形を検査し、`topoOrder` が null なら FAILED |
| テナント分離（D6・T1） | 問題なし。3 モデルが `TENANT_MODELS`、`FlowVersion` が `CHILD_MODELS`。素の prisma は回収の `queue.ts` だけ（allowlist に理由付き）。IDOR の表にフロー・実行・取り消し・出力ページ、一覧の表に `/api/flows` `/runs` `/parts` `/api/canvas` がある。キャンバスに B の flowId は書けない。結果ページは `CustomPage.flowId` 1 つだけ。**役割の分離は指摘 1・2** |
| 冪等・二重実行・同時実行・タイムアウト | `(orgId, requestId)` の unique、`(orgId, slug)` の unique、着手・再開・取り消しは条件付き `updateMany`。心拍は 30 秒、2 分途絶えたら回収、承認待ちは 7 日で EXPIRED。SIGTERM で中断の印。中断した実行は自動でやり直さない。統合テストで並行を確かめている。差分は指摘 6・7・8。実行全体の 5 分（`TIMEOUT`）のテストは無い |
| プラン上限・閲覧のみ・レート制限 | `FLOW_LIMITS` 1 か所。受け付けの順は 定義 → 有効 → 入力 → 部品（503 / 403）→ 月間 429 → QUEUED 429 → 二重 409。書き込みは requireAuth の 402。QUEUED の回収でも `orgEntitlement` を見る。IP 制限は保存 60 回・実行 30 回。`bodyLimit` は 64 / 128KB。差分は指摘 9 |
| 監査ログ | 問題なし。`AuditEvent` の meta は `{ flowId, slug, version, changed: 項目名 }` だけで、定義も値も入れない。ログ（`createLogger('flows')`）は runId・nodeId・コードだけ。上流のエラー本文は利用者に返さない |
| XSS | 問題なし。新しいファイルに `dangerouslySetInnerHTML` も `innerHTML` も `window.open` も無い（ソーステストあり）。外への `href` は運営にだけ返る `editorUrl` だけ（`noopener noreferrer`）。`navigate` の行き先は許可リストを通った内部パス |
| エラー形式 | `sendError` で揃っている。400 の `issues` と `FLOW_PAGE_INVALID` は、`{ success:false, error:{ code, message, issues } }` の拡張で一貫している |
| UI 規約 | `check:tokens` 0（hex・rgba 無し）。`border-l` は右パネルの区切り線だけで、左アクセントバーは無い。影は浮くもの（メニュー類）だけ。ラベルは一語、押せる要素は 44 / 56px。スマホは `lazy()` の分岐で `@xyflow/react` とその CSS を読まない（import をたどって確認）。差分は指摘 13（カードの入れ子） |
| 設計書との差分 | 指摘 9・12 のほか: §4.3 のスマホの「名前」変更が無い。§3.2 の実行中の線の `animated` は C7-1 で持ち越し。§8.5 の `N8N_EDITOR_BASE_URL` は K60 で `n8nUrl` に置き換え済み |

## テストの抜け

| 層 | 抜け |
|---|---|
| gateway | 指摘 1・2 の権限（オーナー限定フローの承認と Task の読み取りをメンバーが試す）。実行全体 5 分の `TIMEOUT`。AI の出力に指示文を入れても下流の config・宛先が変わらないこと（T4 のランナーテスト。DATA_FENCE が入ることだけは見ている）。レート制限（T11）。データノードの書き込みのタイムアウト |
| web | PC キャンバスの編集 → 保存 → 409。取り直しと編集の競合（指摘 3・4）。受信の承認・却下の失敗と二重押し。キャンバス・フローの保存・実行・テンプレート作成で 402 を受けたときの表示。スマホの「有効」切り替え。`useMediaQuery` の切り替わり |

## DoD（§1.4）

| # | 状態 | メモ |
|---|---|---|
| D1 | △ | web テストあり。目視は未（C7-3・C8-2） |
| D2 | ○ | 統合テスト（並行） |
| D3 | ○ | gateway・web テスト。ただし指摘 4 で編集が消えうる |
| D4 | ○ | n8n 未設定のテスト |
| D5 | △ | 止まって続く点は ○。**承認者の役割が足りない（指摘 1）** |
| D6 | △ | 組織間は ○。**組織内の役割の分離が Task 経由で抜ける（指摘 2）** |
| D7 | ○ | shared-types と gateway のテスト（同時の受け付けで少し超えうる。指摘 8） |
| D8 | △ | 56px の行は確認済み。390px の目視は未 |
| D9 | ○ | ソーステストと fetch のモック |
| D10 | 未確認 | このレビューでは回していない |

持ち越しのうち本番前に要るもの: C5-3（保持期間の掃除。指摘 5）、C6-3（`flow:parts:check`）、C7-3 / C8-2 / C9-1（目視）。

## 対応状況（2026-11-19）

高・中はすべて直した。低は 16 件のうち 13 件をコードで直し、8 は設計書に明記して許容（再開の pump 化は見送り）。決定は設計書 §14 の K88〜K94、残りは「持ち越し」の C10-1〜C10-3。

| # | 重大度 | 状態 | 内容 | コミット |
|---|---|---|---|---|
| 1 | 高 | 直した | 承認・却下は max(フローの minRole, ノードの minRole)。フローが見えない人には 404、消えたフローは ADMIN 以上（`services/flows/task-access.ts`・`queue.ts` の `approvalDenied`）。テスト: オーナー限定フローの送信前承認を MEMBER・ADMIN が叩くと 404、ADMIN 限定フローの確認（MEMBER）を MEMBER は 404、消えたフロー | 3ad63b3 |
| 2 | 中 | 直した | `taskType='flow'` の Task を一覧・単体・ログ・stream でフローの minRole で絞る（受信・成果物も同じ API）。汎用 PATCH・DELETE・承認データの無い approve/reject は 409 `FLOW_MANAGED`。テスト: MEMBER の一覧・単体・ログに出ない、PATCH/DELETE/approve が 409 | 3ad63b3 |
| 3 | 中 | 直した | キャンバスの下書きに編集開始時の版を持ち、保存はその版で送る。テスト: 編集中に取り直しで版が上がっても 409 を 1 行（`CanvasBoard.render.test.tsx`） | 57a23f4 |
| 4 | 中 | 直した | フロー画面・出力ビルダーは版で作り直さない。編集中は「他の人が更新しました」、保存は元の版で 409。未編集なら乗り換え。`beforeunload` の警告（BrowserRouter なので `useBlocker` は不可）。テスト: 編集が残る・409・未編集は追従・自分の保存の後は新しい版・beforeunload | 57a23f4 |
| 5 | 中 | 直した | 回収の tick で 1 日 1 回、プランの日数を過ぎた終わった `FlowRun` を消す（当月・承認待ちは残す、Task は残す）。単体と実 Postgres の統合テスト。C5-3 を済に | 6f9e468 |
| 6 | 低 | 直した | 利用者の `requestId` の `sched:` 始まりを 400 | 0645049 |
| 7 | 低 | 直した | データノードの書き込みは打ち切らず結果を待つ（読み取りだけ 5 秒）。テスト `data-node.test.ts` | 0645049 |
| 8 | 低 | 見送り（明記） | 同時の受け付けで数件超えうることを設計書 §7.6 に明記。承認後の再開の pump 化は、QUEUED へ戻すと startedAt・回収・QUEUED 20 の数え方が変わり壊す範囲が大きいので見送り（K90） | 本コミット（docs） |
| 9 | 低 | 直した | 実行の受け付けに組織ごとの窓（`org-throttle` の `flow_run`・30 回/分・429 `RATE_LIMITED`） | 0645049 |
| 10 | 低 | 直した | 指示に差し込んだ上流の値は「差し込み N」の目印だけ system に残し、値は資料側へ。囲みのタグ（全角も）を値から除く（K92） | 0645049 |
| 11 | 低 | 直した | 既存のフローが見えない役割なら、キャンバスを書き換える前に 404 | 0645049 |
| 12 | 低 | 直した | PATCH の `node.config` を型ごとの許可リスト（shared-types `flowMobileTextKeys`）で縛る | 0645049 |
| 13 | 低 | 直した | 受信のフロー承認のプレビューを枠なし（`RunPreviewRow` の `plain`）に。既存のエージェント承認の入れ子は範囲外（C10-3） | 57a23f4 |
| 14 | 低 | 直した | 取得失敗を空と見せない・gateway の文言・処理中をカードごと・却下にも処理中とエラー | 57a23f4 |
| 15 | 低 | 直した | 閲覧のみなら 編集・保存・実行 を止めて「閲覧のみです」（`useReadOnlyOrg`）。スマホの「有効」に処理中 | 57a23f4 |
| 16 | 低 | 直した | `aria-label` はそのまま（K68）、次・未作成・承認待ちを `aria-describedby` で結ぶ | 57a23f4 |
| 17 | 低 | 直した | テンプレート作成の二重押しガードを `useRef` に | 57a23f4 |

確認: ルートで `npm run lint`（エラー 0・警告 9 は既存）・`npm run typecheck`・`npm test`（web 490・gateway 1788・shared-types 242）・`npm run build`・`npm run check:tokens --workspace=apps/web`（違反 0）・`npm run test:int`（72）が通る。Python・Go は触っていない。

対応中に見つけた残り: フローの版は定義の変更でしか上がらないため、名前・役割・配置だけの同時変更は 409 にならない（C10-1）。データノードの `deliverable` 一覧はフローの役割で絞っていない（C10-2・題名だけ）。
