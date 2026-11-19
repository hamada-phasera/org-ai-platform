# 業務フローの部品を n8n で作る（運営向け）

業務フロー（`docs/design/canvas-home.md`）の「部品」ノードのうち、`via: { kind: 'n8n' }` のものは運営が n8n に置く
**全組織共通のワークフロー**で動く。お客さんは部品に**入力値を渡して呼ぶだけ**で、n8n の画面・API には触れない
（n8n のライセンス上の線引き。設計書 §2・K1・K2）。

> ⚠️ お客さんの操作で n8n のワークフローを作る・変える経路は作らない。部品は運営がこの手順で 1 つずつ足す。

## 1. 足す手順

1. `packages/shared-types/src/flow-parts.ts` の `FLOW_PARTS` に 1 件足す（`key`・`title`・`icon`・`via: { kind: 'n8n' }`・`input`・`output`・
   `sideEffect`・`idempotent`・`minPlan`・`timeoutMs`）。外へ送る部品は `sideEffect: 'external_send'`（ランナーが必ず承認で止める）。
2. `apps/n8n-workflows/parts/part-<key>.json` を置く（下の決まりどおり。サンプルは `part-pdf_make.json`）。
3. `npm test`（`scripts/__tests__/n8n-flow-parts.test.mjs` がファイル名・パス・認証・入口の検査・カタログとの 1 対 1 を確かめる）。
4. デプロイ後に `npm run n8n:import`（`parts/part-*.json` も取り込み、Header Auth の credential を付けて有効化する）。

## 2. ワークフローの決まり

| 項目 | 決まり |
|---|---|
| 名前 | `part-<key>` |
| Webhook | パス `parts/<key>`・POST・Header Auth（`x-org-ai-token`＝`N8N_WEBHOOK_AUTH_TOKEN`）・`responseMode: responseNode`。gateway は `${N8N の URL}/webhook/parts/<key>` にしか送らない（カタログに URL・パスを書く欄は無い） |
| 本文 | `{ orgId, part, input, runId, nodeId, idempotencyKey, actor: { userId, role }, plan, aiEngineUrl }`。メール・氏名は届かない |
| 入口の検査 | Webhook の直後で `body.orgId`（形）・`body.part`（自分の key）・`body.idempotencyKey`（空でない）を確かめ、違えば 400 を返して何もしない |
| 組織 | 共有のワークフローなので、データは必ず `body.orgId` で分ける。**組織ごとの資格情報が要る処理は部品にしない**（capability 経由にする。n8n に顧客の資格情報を置かない） |
| 冪等 | 同じ `idempotencyKey` は 1 回だけ処理する（`idempotent: true` の部品は接続エラーのとき gateway が 1 回だけ再送する） |
| LLM | 使うなら `body.aiEngineUrl` の `/llm/chat`（LLMRouter・AILog・PII マスクを通す）。直接 LLM を呼ばない |
| 応答 | JSON・256KB 以内・`timeoutMs`（最大 30 秒）以内。カタログの `output` に宣言したキーだけが使われ、他は捨てられる |
| 失敗 | 4xx/5xx を返せば、そのノードが失敗して下流は止まる。ai-engine へのフォールバックはしない（送ったつもりで届いていない事故を避ける） |

## 3. サンプル `part-pdf_make.json`

Webhook → 入口の検査（違えば 400）→ `FLOW_PDF_SERVICE_URL`（運営が用意する PDF 化の先。n8n の環境変数）へ POST → `{ url }` を返す。
PDF 化の中身（どのサービスを使うか）は運営が決める。竹以上（`minPlan: 'PRO'`）。

## 4. 確かめ方

- 部品の画面（フロー画面の右パネル）で「未接続」が消えること（`config.n8nConfigured`）。
- 運営（`ADMIN_EMAILS`）だけに「n8n で開く」が出る（`services/n8n/part-editor.ts` が public API を GET だけ）。
- セットアップ状況（設定 > 基本・オーナー）の「業務ページ」の行で n8n に届いていること。
