# 業務ページ（n8n 連携）レビュー

- 対象: `feat/custom-pages` の `git diff 82ad064..HEAD`（9 コミット・94 ファイル）。照合先は `docs/design/custom-pages.md`（§0〜§15・K1〜K49）
- 日付: 2026-11-18。コードは変更していない
- 手元で回したもの: `npm run lint` / `typecheck` / `test`（gateway・web・shared-types・scripts すべて通過）/ `build` / `check:deploy` はすべて 0 終了。
  `test:int` は `TEST_DATABASE_URL` が無くスキップになるため**回していない**（CI の integration ジョブで要確認）
- 413 の本文の形は、gateway と同じ版の Fastify で `bodyLimit` を超える POST を送って確かめた（下の M1）

## 結論

高（すぐ直すべき穴）は見つからなかった。テナント分離・登録トークン・SSRF・XSS の 4 つは、設計どおり**構造で**守られている。

| 観点 | 結果 | 根拠 |
|---|---|---|
| テナント分離 | OK | ルートはすべて `authOf(request).db`。素の prisma は `resolvePageToken` の 1 か所だけ（allowlist に理由付き）。登録経路はトークンで組織を決め、`runAsTenant` + `tenantDb`。分離テストは IDOR の表（`GET/PATCH/DELETE /:slug`・`data`・`actions`・`tokens/:id`）と一覧の表に追加済みで、両方に所属するユーザー・登録トークン経由・叩く URL に B の orgId が入らないことも固定されている |
| 登録トークン | OK | `flowpg_` + 256 bit、DB には sha256 と先頭 10 文字だけ。照合はハッシュの一意検索なので文字列比較の時間差は出ない。失敗は一律 401。生値は発行の応答にだけ出て、監査は id と prefix だけ。`registrarId` で `sanitizeAuditMeta` の伏せ字も避けている（K26） |
| SSRF | OK | URL は `buildPageHookUrl` が `${環境変数}/webhook/pages/${encodeURIComponent(orgId)}/${hook}` で組み立て、hook はスキーマとここの 2 か所で `^[a-z0-9-]+$` に縛っている。`redirect: 'error'`・10 秒・256KB・JSON だけ。セットアップ確認の `/healthz` もリダイレクトを追わない |
| XSS | OK | ブロックは 7 種で、すべて `.strict()`。`style` / `href` / `className` は書けない。n8n の応答は `projectQueryResult` で宣言した key とスカラーだけに切り詰めている。web は `dangerouslySetInnerHTML`・`<a`・`<img`・`style={` を使わないことをソーステストで固定し、リンク先は `/p/${encodeURIComponent(slug)}` だけ |
| zod の抜け | おおむね OK | 定義・登録 body・PATCH・トークン発行・submit の body と入力が `.strict()`。抜けは M1（body の上限とスキーマの上限が食い違う）だけ |
| 監査ログ・入力値 | OK | `PageActionLog` は `inputKeys` だけ。ログに入力値も応答本文も出さないことをテストで確かめている。zod のエラーで値を返しうる enum / literal は文言を差し替えている |
| エラーの形 | 1 件抜けあり | 413 だけ統一の形にならない（M1） |
| UI の決まり | おおむね OK | カードの入れ子なし・左アクセントバーなし・区切り線と表だけ・ラベルは一語（スキーマで 6〜8 文字）。`Card` と `border-l` はソーステストで禁止。指摘は L1 と L9 |

## 指摘

| # | 重大度 | 場所 | 問題 | 直し方 |
|---|---|---|---|---|
| M1 | 中 | `routes/pages.ts:242`（`bodyLimit: PAGE_SUBMIT_BODY_LIMIT`）、`routes/pages.ts:303`・`routes/n8n-pages.ts:85`（64KB）、`shared-types/pages.ts` の `textareaMax` | (1) `bodyLimit` を超えたときの 413 は Fastify の既定の本文 `{"statusCode":413,"code":"FST_ERR_CTP_BODY_TOO_LARGE","error":"Payload Too Large","message":"Request body is too large"}` になる。`{ success:false, error:{code,message} }` ではないうえに英語で、web の `apiErrorOf` は文言を拾えず「送信できませんでした」としか出ない。n8n 側の構築者も原因が分からない。(2) スキーマが許す入力が 16KB に収まらない。textarea は 2000 文字まで、項目は 12 個まで書けるので、日本語（3 バイト/字）の textarea を 3 つ埋めるだけで 18KB を超え、定義どおりに正しく入力しても 413 になる。テスト（`page-actions.route.test.ts:312`）は状態コードしか見ていない | app に `setErrorHandler`（または `onSend`）を足し、`FST_ERR_CTP_BODY_TOO_LARGE` を `sendError(reply, 413, 'PAYLOAD_TOO_LARGE', '送信する内容が大きすぎます')` に置き換える。あわせて `pageDefinitionSchema` の superRefine で「1 フォームの maxLength の合計 × 3 バイト + 余白 ≤ 16KB」を検査するか、bodyLimit を最大の入力から計算した値（例 96KB）に上げる。テストは本文の形まで確かめる |
| M2 | 中 | `apps/n8n-workflows/pages/page-inquiries.json`（「ページを登録」ノードの `jsonBody`）、`services/pages/upsert.ts:168-170` | 設計 §5.3 は「管理者が画面で変えた値を、ワークフローの再実行で黙って戻さない」としているが、守れていない。(1) サンプルの登録 body に `"status": "DRAFT"` が入っているので、手順書どおりに FLOW で公開した後、定義を直して「登録を実行」をもう一度押すと**非公開に戻り、メンバーのナビからページが消える**。構築者はこのサンプルを写して使うので、同じ書き方が広がる。(2) `title` は必須で毎回上書きされ、`icon` もサンプルが書いているので、設定画面（PATCH）で変えたタイトルとアイコンは再実行で元に戻る | サンプルの body から `status` を消す（新規作成の既定は DRAFT なので書かなくても同じ）。`docs/custom-pages-n8n.md` に「status / sortOrder / minRole は、意図して変えるときだけ書く」と書き足す。title と icon は「作成時と定義が変わったときだけ反映」にするか、PATCH で変えた項目を行に記録して n8n からは上書きしない。テストには「公開 → サンプルの body をそのまま再登録 → PUBLISHED のまま」を足す |
| M3 | 中 | `services/pages/action-runner.ts:232` `runPageQuery`、`hookBody` | 「閲覧のみ」（解約・トライアル切れ）の組織でも、query は開くたびに n8n のワークフローを動かし続ける。K6 で「表示は通す」と決めているが、構築規約（§9）は「LLM は `body.aiEngineUrl` の `/llm/chat` で呼ぶ」としているので、query のワークフローが LLM を使っていれば、契約の無い組織が AI を動かし続ける（CLAUDE.md「閲覧のみの組織では AI を動かさない」の趣旨から外れる）。n8n 側は契約の状態を知るすべが無い（body に入っていない） | (a) `hookBody` に `readOnly: boolean`（`orgEntitlement` の結果）を足し、構築規約に「readOnly のときは LLM や外部の呼び出しをしない」を書く。(b) もっと固くするなら、閲覧のみの組織の query は `staleTime` を延ばすか、組織ごとの窓を絞る。どちらにするか決めて設計書 K6 に追記する |
| L1 | 低 | `components/pages/ConfirmDialog.tsx:20-31`、`useSubmit.tsx`（`onCancel={() => setConfirming(null)}`） | effect の依存に毎回作り直される `onCancel` が入っているので、親が再描画されるたびに cleanup（直前の要素へフォーカスを戻す）→ effect（「やめる」にフォーカス）が走る。ダイアログを開いている間に再取得などで再描画されると、「実行」へ移したフォーカスが「やめる」に戻される。フォーカスを閉じ込めていないので、Tab で背後のフォームに抜ける。`shadow-lg` は §7.3 の「影なし」と食い違う（既存のモーダルに合わせたのなら設計に一言書く） | `onCancel` を ref に入れて effect の依存は `[]` にする。Tab / Shift+Tab を 2 つのボタンの間で回す。描画テストに「再描画してもフォーカスが動かない」を足す |
| L2 | 低 | `action-runner.ts:316-370` | 記録を `PENDING` で作ってから `updateMany` で確定するまでの間に例外が出ると（DB の一時的な失敗など）、行は `PENDING` のまま残って当月の件数に数えられ続ける。n8n に届いたのかどうかも後から分からない | 9〜11 を try/finally で包み、例外のときは `FAILED`（届いたかどうか不明）で確定する。あるいは一定時間を過ぎた `PENDING` を回収の対象にし、`cleanup-hold-list.md` に載せる |
| L3 | 低 | `services/pages/page-token.ts:83-96` `issuePageToken` | 本数を数えてから作るので、同時に 2 回発行すると有効なトークンが 3 本になりうる（オーナーの二度押し程度で起きる） | `$transaction` の中で数えて作る（組織の行を `SELECT … FOR UPDATE` で取る）か、作った後に数え直して超えていたら取り消す |
| L4 | 低 | `components/Settings/PagesSection.tsx:107-120`（並び替え） | ADMIN にはオーナー限定のページが一覧に出ない（K28）。並び替えは見えている行だけを 0, 1, 2… に振り直すので、見えないページと番号がぶつかり、オーナーのナビでの並びが作成日時の順で決まってしまう | 振り直しは「見えている行が今持っている番号の集合」を並べ替えて割り当てる（他の行の番号に触れない）。または gateway に並び替えの API を 1 本足し、管理できる行の中だけで振り直す |
| L5 | 低 | `PagesSection.tsx`（`IssuedTokenRows` の `onClose`） | 「閉じる」で `issued` は消えるが、生トークンは `issueMut.data`（react-query のミューテーションの状態）に、タブを離れるまで残る。画面には出ないが「閉じたら二度と出ない」とずれる | `onClose` で `issueMut.reset()` も呼ぶ |
| L6 | 低 | `config/env.ts` `n8nConfigured` と `n8nUrl` | `n8nConfigured` は空白を除いてから見るが、`n8nUrl` は `??` なので空文字を飛ばさない。`N8N_CLOUD_URL=""`（空のまま render に残った等）と `N8N_URL` を同時に入れると、`connection: 'ok'` なのに URL が `/webhook/pages/…`（相対）になり、取得も送信も常に 502 になる。セットアップ状況も「確認できず」になって原因が見えない | `n8nUrl` も `env.N8N_CLOUD_URL?.trim() \|\| env.N8N_URL?.trim() \|\| 既定値` にそろえる。env テストに空文字の場合を足す |
| L7 | 低 | `middleware/rate-limit.ts` `PAGE_REGISTER_RATE_LIMIT`・`PAGE_ACTION_RATE_LIMIT` | 登録の上限（20 回/分）は IP ごとだが、登録してくるのは全テナント共有の n8n 1 台（§0）なので、実際には**全組織あわせて** 20 回/分になる（定義を一斉に更新すると 429）。データ取得の 60 回/分も IP ごとなので、1 つの NAT の内側にいる事務所では、query を 3 つ持つページを全員あわせて 20 回開くと上限に当たる | 登録は `keyGenerator` でトークンのハッシュの先頭をキーにする（当てずっぽうの対策は 256 bit のエントロピーで足りる）。データ取得は JWT の `sub` をキーにするか、上限を上げて組織ごとの窓（120 回/分）に任せる。`docs/security.md` に前提を書く |
| L8 | 低 | `upsert.ts:175`、`sample.ts` | 管理者が `PUT /api/pages/:slug` で SEED のページを上書きすると `source` は MANUAL になるが、`sampleData` はそのまま残るので、サンプルモードでは新しい定義に古いサンプルの応答を当てて返す（開発環境だけの話。表示が「表示できません」になるなどの混乱） | MANUAL / N8N に変わるときは `sampleData: null` にする（seed のページだけがサンプルを持つ、という K13 の前提に合わせる） |
| L9 | 低 | `DataNotice.tsx:24`（「設定」）、`SubmitFeedback.tsx:17`・`pages/CustomPage.tsx:99`（「プラン」） | 文中のリンクに `max-lg:min-h-11` が無く、390px では押せる面が 44px に届かない（D6「押せる要素 44px 以上」） | `inline-flex items-center max-lg:min-h-11` を付ける（`CustomPage.tsx:34` の「一覧」と同じ書き方） |
| L10 | 低 | `shared-types/pages-plan.ts`（`PAGE_LIMITS` のコメント「JST の月初から」・`PAGE_ACTION_LOG_STATUSES`）、`config/env.ts:387-394`、設計書 §7.2 | 書いてあることと実装のずれ: (1) 月の数え方は K27 で UTC の暦月にしたのに、コメントは JST のまま。画面の「来月 1 日に戻ります」も、日本時間では 1 日の 9:00 に戻る。(2) `PAGE_ACTION_LOG_STATUSES` に K25 の `PENDING` が無い。(3) `appBaseUrl` の getter が `billingTrialDays` の JSDoc とその本体の間に挟まり、JSDoc が `appBaseUrl` に付いている。(4) §7.2 の `usePageData.ts` は実際には `PageContext.tsx` の中にある | コメントと定数を直す。`appBaseUrl` を JSDoc の前に移す。設計書 §7.2 のファイル名を実装に合わせる |

## 設計書との差分（記録済みのものは除く）

K22〜K49 に「実装時」として理由付きで残っている差分（月は UTC・413・サンプルの submit は記録より前に返す・未接続なら記録を消す、など）は、どれも妥当で設計書にも書かれている。記録されていない差分は次の 3 つ。

| 項目 | 設計 | 実装 | 扱い |
|---|---|---|---|
| 再実行で管理者の値を戻さない（§5.3） | status / sortOrder / minRole は body に書いたときだけ上書き | 実装はそのとおりだが、サンプルが `status` を書いている。title / icon は常に上書き | M2 |
| 閲覧のみの組織の query（T12） | submit と登録は 402 | query は n8n（とその先の LLM）を動かし続ける | M3 |
| §5.2 の 6「body 16KB まで → 400」 | 400 `VALIDATION_ERROR` | 413（K36）。本文が統一の形にならない点は記録されていない | M1 |

## テストの抜け

分離・上限・タイムアウト・256KB・非 JSON・再試行・二重送信・閲覧のみ・サンプルモードの本番無効まで、§11 の表はほぼ埋まっている。足りないのは次のとおり。

| 足すテスト | 対応する指摘 |
|---|---|
| 413 の本文が `{ success:false, error:{ code, message } }` で日本語（submit と登録の両方） | M1 |
| 最大の入力（textarea × n を上限まで、日本語）が body の上限に収まる、または定義の時点で弾かれる | M1 |
| 公開した後に、サンプルの body をそのまま再登録しても PUBLISHED・タイトル・アイコンが変わらない | M2 |
| 閲覧のみの組織の query で n8n に渡る body（`readOnly` を足した場合） | M3 |
| `updateMany` が失敗したときに記録が PENDING のまま残らない | L2 |
| 空文字の `N8N_CLOUD_URL` と `N8N_URL` の組み合わせ | L6 |
| ConfirmDialog: 再描画でフォーカスが動かない・Tab がダイアログから抜けない | L1 |
| 統合テスト（`test:int`）を実 DB で 1 回回した結果（このレビューでは DB が無く未実施） | D1・D7 |

## DoD（§1.4）の状況

| # | 状況 | 補足 |
|---|---|---|
| D1 | 自動テストは揃っている。実 DB では未確認 | `custom-pages-seed.int.test.ts` が通し。`test:int` は CI で確認 |
| D2 | 未確認（手動の項目） | ユーザー作業 U1〜U4 の後。再実行で非公開に戻る M2 を直してから確かめるのがよい |
| D3 | 達成 | 定義に無い項目・型違いは 400 で n8n に届かない（ルートテスト） |
| D4 | 達成 | 分離テストと `buildPageHookUrl` の固定 |
| D5 | 達成 | 上限 403 / 429、ページ上部の帯と設定画面の利用状況 |
| D6 | ほぼ達成 | 1 列・`lg:hidden` の縦積みで横スクロールを出していない。文中リンクが 44px に届かない（L9）。390px での目視は未実施 |
| D7 | 一部確認 | lint / typecheck / test / build / check:deploy は手元で通過。`test:int` は未実施 |
