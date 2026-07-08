# n8n 統合設計 — サイクル1バーティアル（営業/分析/SNS）2026-07-08

> 目的: サイクル1で実装した3部署の機能を、既存の n8n 連携モデルにどう載せるかの設計。
> 前提原則（既存・不変）: **DB=真実の源 / n8n=best-effort 加速レイヤー / AI Engine=必ず完了するフォールバック**。
> n8n が落ちていても全機能が成立すること（Render無料枠のコールドスタート耐性）。

## 0. 現行モデル（grounding）
- `dispatchQueuedTask(task)`: `department→webhookPath` で n8n `/webhook/<path>` に POST（ヘッダ認証 `x-org-ai-token`、callbackUrl=`/api/webhooks/n8n/task-complete`・logUrl・aiEngineUrl 同梱）。失敗/未定義なら `executeTaskViaAiEngine`（`/orchestrate`）でフォールバックし Task を DONE/FAILED に。
- n8n WF は gateway webhook にコールバックして Task を更新（非同期完了）。
- Agent 作成で n8n Public API により `agent-<id>` WF を best-effort 生成（`buildAgentWorkflowJson`）。
- 生成物=`status='DONE'` の Task（Deliverable モデルは無い）。全 LLM 呼び出しは AILog 記録が原則。

## 1. 設計の背骨（3つの判断軸）
各 dept 操作を次の3軸で分類して n8n の関与を決める:
1. **生成系（LLM を呼ぶ）** → Task 化して `dispatchQueuedTask` に載せる。n8n WF があれば加速、無ければ AI Engine フォールバック。**副作用として AILog 記録・リトライ・コールバックが無料で付く**（＝営業#5/コンプラの直 `/llm/chat` 問題も解消）。
2. **副作用系（外部投稿・送信）** → **人間承認ゲートの後**でのみ n8n を発火。投稿など不可逆な副作用は初期は「準備/キュー止まり（シミュレート）」で、実投稿は明示フラグで段階解放。
3. **監視系（定期集計・閾値通知）** → cron トリガ（n8n schedule もしくは Vercel Cron）→ 読み取り集計 → 条件 → 通知。Task 化しない読み取り専用。

## 2. 部署別 統合パターン

### 🏷 営業（SALES）
- **提案書生成（S-3）**: 現状は直 `/llm/chat`。→ **Task(`taskType='proposal'`, dept=SALES) 化** して `dispatchQueuedTask` へ。n8n WF `sales-proposal`（テンプレ→本文生成→Doc化）があれば加速、無ければフォールバック。AILog 自動記録。
- **パイプライン自動化（イベント駆動）**: 商談ステージ PATCH（例 →PROPOSAL）を契機に follow-up Task を enqueue（提案ドラフト自動生成・通知）。副作用は通知どまり（安全）。
- 関与度: **中**（生成系は載せる価値大、パイプライン自動化はオプション）。

### 📣 SNS（MARKETING）
- **下書き生成（N-1）**: 直 `/llm/chat` → **Task(`taskType='sns'`) 化**して dispatch へ（AILog 記録＋加速）。
- **承認ゲート（N-2）＝設計の要**: 承認は `status: PENDING_APPROVAL→APPROVED` のみ。**n8n は APPROVED を契機にのみ発火**し、それでも:
  - 段階0（現状）: 投稿しない。承認＝状態遷移のみ。
  - 段階1: APPROVED+`scheduledAt` を n8n cron が拾い「投稿準備（プレビュー生成・キュー投入）」まで。**実 API 投稿はしない**。
  - 段階2（明示解放時のみ）: 環境フラグ `SNS_LIVE_POST=true` かつ dept 承認済みのみ実投稿。既定は false。
- コンテンツカレンダー（N-3）: 表示は現状の DB 読み取りで完結。予約実行は段階1の n8n cron に対応。
- 関与度: **高（ただし副作用は厳格ゲート）**。**自動投稿は絶対にデフォルト化しない。**

### 📊 分析（ANALYTICS）
- 生成系はほぼ無い（読み取り/集計中心）。usage-metrics-svc は自前の非同期 rollup worker を既に持つ。
- **KPIアラート（A-6）= n8n の適所**: n8n schedule（例 日次/時次）→ `/metrics/departments` を叩く → 閾値（コスト急増・失敗率・p95レイテンシ）超過なら通知（Slack/メール）。RiskEvent 連携も。
- **rollup トリガ**: 現状 svc 内 worker（5分間隔）。n8n cron に寄せるかは任意（二重管理を避けるなら svc 内のままでよい）。
- 関与度: **低〜中（cron 監視・通知のみ、Task 発火はしない）**。

## 3. トリガ分類（横断）
- **on-demand（webhook）**: 生成ボタン → Task → n8n webhook/フォールバック。
- **event-driven**: パイプラインステージ変更 / SNS 承認 → follow-up Task enqueue。
- **scheduled（cron）**: 分析アラート・カレンダー投稿準備。n8n schedule か **Vercel Cron**（フロントが Vercel なら cron はこちらが素直）。

## 4. webhook パス設計
現行は `agent-<id>`（エージェント単位）。dept バーティカルの system 操作用に固定パスを足す:
`sales-proposal` / `sns-draft` / `sns-publish-prep`（段階1）/ `analytics-alert`。
`department→webhookPath` マップを dept×操作に拡張、または「system agent」として既存モデルに寄せる（後者は追加コード最小）。

## 5. 段階導入（推奨順）
1. **生成系の Task 統一**（提案・SNS下書きを dispatch モデルへ）→ AILog/リトライ/フォールバック獲得＋直 `/llm/chat` 廃止。**最も費用対効果が高い。**
2. **分析アラートの n8n cron**（読み取りのみ・低リスク）。
3. **SNS 投稿準備（段階1・投稿しない）**。
4. 実投稿（段階2）は経営判断で明示解放。

## 6. 要決定（人間）
- (D1) 生成系（提案/SNS下書き）を **Task/dispatch モデルに寄せる**か、現状の直呼びを維持するか（推奨: 寄せる）。
- (D2) SNS 投稿の到達段階（0/1/2 のどこまで今サイクルでやるか。推奨: 段階1まで、実投稿は保留）。
- (D3) スケジューラは **n8n schedule** か **Vercel Cron** か（フロント Vercel なら Cron が素直）。
- (D4) n8n ホスティング: Render 無料枠継続 / n8n Cloud（常時稼働・安定）。
- (D5) 分析 rollup を svc 内 worker のままにするか n8n に寄せるか（推奨: svc 内のまま、二重管理回避）。
