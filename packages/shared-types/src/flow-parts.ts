/**
 * 業務フローの部品カタログ（docs/design/canvas-home.md §5.7・§8）。運営が 1 件ずつ足す（n8n のワークフロー JSON と同じ PR）。
 *
 * - 部品＝運営が用意した既製の処理。お客さんは**入力値を渡して呼ぶだけ**（ワークフローの論理には触れない。§2 L5・Gr1）。
 * - n8n の Webhook パスは gateway が `parts/<key>` に組み立てる。**ここに URL・パスを書く欄は無い**（K6・T6）。
 * - `via.kind='capability'` は既存の `resolveAndExecute`（Slack・Google の native adapter → n8n `cap-*`）をそのまま使う（K7）。
 *   入力の key は capability の引数名に合わせる。配列の引数（スプレッドシートの headers / rows）は文字で受け、
 *   ランナー（チャンク 6）が「カンマ区切り・1 行 1 件」を配列に直す。
 * - `APPROVAL_REQUIRED_CAPS` に載る capability は `external_send`（必ず承認で止まる。テストで突き合わせる）。
 * - 入力の検証スキーマは flows.ts の `buildPartInputSchema(part)`（zod を使うのでここに置かない）。
 * ⚠️ ここに zod を import しない（スマホのステップリスト・追加メニューが読む。flows-core.ts と同じ理由。設計書 K29）。
 */
import type { FlowPartSpec } from './flows-core';

export const FLOW_PARTS: readonly FlowPartSpec[] = [
  {
    key: 'google_doc',
    title: '文書',
    icon: 'file-text',
    via: { kind: 'capability', name: 'create_google_doc' },
    input: [
      { key: 'title', label: '題名', type: 'text', required: true, maxLength: 200 },
      { key: 'content', label: '本文', type: 'textarea', required: true, maxLength: 2000 },
    ],
    output: [
      { key: 'url', type: 'text' },
      { key: 'documentId', type: 'text' },
    ],
    sideEffect: 'none',
    // 作成は 2 回呼ぶと 2 つできる＝再試行しない
    idempotent: false,
    minPlan: 'STARTER',
  },
  {
    key: 'google_sheet',
    title: '表計算',
    icon: 'chart-bar',
    via: { kind: 'capability', name: 'create_google_sheet' },
    input: [
      { key: 'title', label: '題名', type: 'text', required: true, maxLength: 200 },
      /** カンマ区切り（ランナーが配列に直す） */
      { key: 'headers', label: '見出し', type: 'text', required: true, maxLength: 500 },
      /** 1 行 1 件・カンマ区切り（ランナーが配列に直す） */
      { key: 'rows', label: '行', type: 'textarea', required: true, maxLength: 2000 },
    ],
    output: [
      { key: 'url', type: 'text' },
      { key: 'spreadsheetId', type: 'text' },
    ],
    sideEffect: 'none',
    idempotent: false,
    minPlan: 'STARTER',
  },
  {
    key: 'slack_notify',
    title: 'Slack',
    icon: 'message-circle',
    via: { kind: 'capability', name: 'notify_slack' },
    input: [
      { key: 'channel', label: '宛先', type: 'text', required: true, maxLength: 80 },
      { key: 'text', label: '本文', type: 'textarea', required: true, maxLength: 2000 },
    ],
    output: [{ key: 'sent', type: 'boolean' }],
    sideEffect: 'external_send',
    idempotent: false,
    minPlan: 'STARTER',
  },
  {
    key: 'email_send',
    title: 'メール',
    icon: 'mail',
    via: { kind: 'capability', name: 'send_email' },
    input: [
      { key: 'to', label: '宛先', type: 'email', required: true, maxLength: 200 },
      { key: 'subject', label: '件名', type: 'text', required: true, maxLength: 200 },
      { key: 'body', label: '本文', type: 'textarea', required: true, maxLength: 2000 },
      { key: 'cc', label: 'CC', type: 'email', maxLength: 200 },
    ],
    output: [{ key: 'sent', type: 'boolean' }],
    sideEffect: 'external_send',
    idempotent: false,
    minPlan: 'STARTER',
  },
  {
    key: 'pdf_make',
    title: 'PDF',
    icon: 'file-text',
    via: { kind: 'n8n' },
    input: [
      { key: 'title', label: '題名', type: 'text', required: true, maxLength: 200 },
      { key: 'body', label: '本文', type: 'textarea', required: true, maxLength: 2000 },
    ],
    output: [{ key: 'url', type: 'text' }],
    sideEffect: 'none',
    // 同じ idempotencyKey は n8n 側で 1 回だけ処理する（docs/flow-parts-n8n.md の決まり）
    idempotent: true,
    minPlan: 'PRO',
    timeoutMs: 20_000,
  },
];

export const FLOW_PART_KEYS: readonly string[] = FLOW_PARTS.map((p) => p.key);

/** キーから部品を引く。知らないキーは undefined（呼び出し側は「部品がありません」に倒す） */
export function findFlowPart(key: string, parts: readonly FlowPartSpec[] = FLOW_PARTS): FlowPartSpec | undefined {
  return parts.find((p) => p.key === key);
}
