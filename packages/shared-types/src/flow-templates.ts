/**
 * 業務フローのテンプレートとホームキャンバスの既定の配置（docs/design/canvas-home.md §5.6）。
 *
 * - テンプレート＝運営がコードで用意するフローのひな形。`POST /api/flows/from-template` が**そのまま複製**する
 *   （LLM を呼ばない・乱数を使わない・ノード ID もテンプレートのまま＝毎回同じ結果。K4）。
 * - テンプレートを直しても作成済みのフローは変えない（`version` を上げると `Flow.templateVersion` で古いことが分かる）。
 * - 全テンプレートと既定の配置はテストで `flowDefinitionSchema` / `canvasLayoutSchema` に通す（壊れたら CI で落ちる）。
 * - 見積・請求は**下書きまで・税務判断はしない**の注記を出力に必ず入れる（CLAUDE.md 経理部・U-10）。
 *   SNS は下書きまで（実投稿はしない）。外へ送るノードは置かない。
 * ⚠️ ここに zod を import しない（ホームの初回ロードが既定の配置を読む。設計書 K29）。型は `import type` だけ。
 */
import type { PageIcon } from './pages-plan';
import type { FlowTemplateKey } from './flows-plan';
import type { CanvasLayout, FlowDefinition } from './flows';

export interface FlowTemplate {
  key: FlowTemplateKey;
  /** 中身を変えたら上げる */
  version: number;
  /** フロー名（1〜24 文字） */
  name: string;
  icon: PageIcon;
  definition: FlowDefinition;
  /** ノードの位置（定義と分ける。K16） */
  layout: Record<string, { x: number; y: number }>;
}

/** 縦 1 本の位置（上から 140px おき） */
function verticalLayout(ids: string[]): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  ids.forEach((id, i) => {
    out[id] = { x: 0, y: i * 140 };
  });
  return out;
}

type FormTriggerConfig = Extract<Extract<FlowDefinition['nodes'][number], { type: 'trigger' }>['config'], { mode: 'form' }>;

/** フォーム → AI（下書き）→ 確認 → 文書（成果物）の 4 段 */
function draftFlow(opts: {
  fields: FormTriggerConfig;
  instruction: string;
  input: string;
  department: 'SALES' | 'MARKETING' | 'ACCOUNTING';
  approvalMessage: string;
  documentTitle: string;
  documentBody: string;
}): FlowDefinition {
  return {
    nodes: [
      { id: 'form', type: 'trigger', label: 'フォーム', config: opts.fields },
      {
        id: 'draft',
        type: 'ai',
        label: '下書き',
        config: { op: 'generate', instruction: opts.instruction, input: opts.input, department: opts.department },
      },
      { id: 'check', type: 'approval', label: '確認', config: { message: opts.approvalMessage, preview: '{{draft.text}}' } },
      {
        id: 'doc',
        type: 'output',
        label: '文書',
        config: { kind: 'document', title: opts.documentTitle, body: opts.documentBody, department: opts.department },
      },
    ],
    edges: [
      { from: 'form', to: 'draft' },
      { from: 'draft', to: 'check' },
      { from: 'check', to: 'doc' },
    ],
  };
}

const DRAFT_LAYOUT = verticalLayout(['form', 'draft', 'check', 'doc']);

/** 見積・請求の出力に必ず付ける注記（税務判断はしない） */
export const FLOW_TAX_NOTICE = '※ 下書きです。金額と消費税の扱いは担当者が確認してください（このシステムは税務判断をしません）。';

export const FLOW_TEMPLATES: Readonly<Record<FlowTemplateKey, FlowTemplate>> = {
  // routes/sales/proposals.ts と同じ入力項目（顧客名・背景・要件・予算）。標準提案書の章立て
  proposal: {
    key: 'proposal',
    version: 1,
    name: '提案書',
    icon: 'file-text',
    definition: draftFlow({
      fields: {
        mode: 'form',
        fields: [
          { key: 'customerName', label: '顧客名', type: 'text', required: true, maxLength: 200 },
          { key: 'background', label: '背景', type: 'textarea', maxLength: 2000 },
          { key: 'requirements', label: '要件', type: 'textarea', maxLength: 2000 },
          { key: 'budget', label: '予算', type: 'text', maxLength: 200 },
        ],
      },
      instruction: [
        'あなたは中小企業の営業担当です。資料をもとに、顧客向けの提案書の下書きを日本語で書いてください。',
        '章立て: エグゼクティブサマリー／課題認識／ご提案内容／期待効果／導入スケジュール／概算費用。',
        '文体は敬体（です・ます）。価格は「要お見積り」とし確定値は書かない。数値や不明点は仮定と明記する。',
      ].join('\n'),
      input: '顧客名: {{form.customerName}}\n背景: {{form.background}}\n要件: {{form.requirements}}\n予算: {{form.budget}}',
      department: 'SALES',
      approvalMessage: '{{form.customerName}} 様向けの提案書を保存しますか',
      documentTitle: '提案書: {{form.customerName}}',
      documentBody: '{{draft.text}}',
    }),
    layout: DRAFT_LAYOUT,
  },
  // 建設業の見積（材料費・労務費・外注費・経費の 4 分類の内訳）。下書きまで
  estimate: {
    key: 'estimate',
    version: 1,
    name: '見積',
    icon: 'clipboard-list',
    definition: draftFlow({
      fields: {
        mode: 'form',
        fields: [
          { key: 'customerName', label: '顧客名', type: 'text', required: true, maxLength: 200 },
          { key: 'projectName', label: '工事名', type: 'text', required: true, maxLength: 200 },
          { key: 'scope', label: '内容', type: 'textarea', required: true, maxLength: 2000 },
          { key: 'notes', label: '条件', type: 'textarea', maxLength: 2000 },
        ],
      },
      instruction: [
        'あなたは建設会社の見積担当です。資料をもとに、見積書の下書きを日本語で書いてください。',
        '内訳は材料費・労務費・外注費・経費の 4 分類に分け、各分類に項目・数量・単位・単価・金額の表を置く。',
        '金額は税抜で集計し、消費税は別の行に分ける。自社雇用の労務費は不課税になりうるので一律 10% と仮定しない。',
        '数量や単価が資料に無いときは数字を作らず「要確認」と書く。税務の判断はしない。',
      ].join('\n'),
      input: '顧客名: {{form.customerName}}\n工事名: {{form.projectName}}\n内容: {{form.scope}}\n条件: {{form.notes}}',
      department: 'ACCOUNTING',
      approvalMessage: '{{form.projectName}} の見積の下書きを保存しますか',
      documentTitle: '見積（下書き）: {{form.projectName}}',
      documentBody: `{{draft.text}}\n\n${FLOW_TAX_NOTICE}`,
    }),
    layout: DRAFT_LAYOUT,
  },
  // 請求書の下書き。送付はしない（送るなら確認の後に人が足す）
  invoice: {
    key: 'invoice',
    version: 1,
    name: '請求',
    icon: 'receipt',
    definition: draftFlow({
      fields: {
        mode: 'form',
        fields: [
          { key: 'customerName', label: '請求先', type: 'text', required: true, maxLength: 200 },
          { key: 'projectName', label: '工事名', type: 'text', required: true, maxLength: 200 },
          { key: 'items', label: '明細', type: 'textarea', required: true, maxLength: 2000 },
          { key: 'dueDate', label: '支払期日', type: 'date' },
        ],
      },
      instruction: [
        'あなたは建設会社の経理担当です。資料をもとに、請求書の下書きを日本語で書いてください。',
        '宛名・件名・明細の表（項目・数量・単位・単価・金額）・小計（税抜）・消費税・合計・支払期日・振込先の欄を置く。',
        '振込先や登録番号など資料に無い項目は「要記入」と書き、数字を作らない。税率は明細ごとに資料に従い、一律と仮定しない。',
        '税務の判断はしない。',
      ].join('\n'),
      input: '請求先: {{form.customerName}}\n工事名: {{form.projectName}}\n明細: {{form.items}}\n支払期日: {{form.dueDate}}',
      department: 'ACCOUNTING',
      approvalMessage: '{{form.customerName}} 宛の請求書の下書きを保存しますか',
      documentTitle: '請求（下書き）: {{form.projectName}}',
      documentBody: `{{draft.text}}\n\n${FLOW_TAX_NOTICE}`,
    }),
    layout: DRAFT_LAYOUT,
  },
  // routes/sns/posts.ts と同じ（下書き → 確認）。実投稿はしない
  sns_post: {
    key: 'sns_post',
    version: 1,
    name: 'SNS',
    icon: 'message-circle',
    definition: draftFlow({
      fields: {
        mode: 'form',
        fields: [
          {
            key: 'platform',
            label: '媒体',
            type: 'select',
            required: true,
            options: [
              { value: 'twitter', label: 'X' },
              { value: 'instagram', label: 'Instagram' },
              { value: 'linkedin', label: 'LinkedIn' },
            ],
          },
          { key: 'topic', label: '話題', type: 'text', required: true, maxLength: 200 },
          { key: 'tone', label: '口調', type: 'text', maxLength: 100 },
        ],
      },
      instruction: [
        'あなたは中小企業の SNS 担当です。資料をもとに、投稿の下書きを日本語で 1 本書いてください。',
        '媒体の文字数に収める（X は 140 字以内）。ハッシュタグは 3 つまで。誇大な表現・断定的な効果の表示はしない。',
      ].join('\n'),
      input: '媒体: {{form.platform}}\n話題: {{form.topic}}\n口調: {{form.tone}}',
      department: 'MARKETING',
      approvalMessage: 'SNS の下書きを保存しますか（投稿はしません）',
      documentTitle: 'SNS下書き: {{form.topic}}',
      documentBody: '{{draft.text}}',
    }),
    layout: DRAFT_LAYOUT,
  },
};

/**
 * テンプレートの複製（深いコピー）。from-template はこれを保存する。
 * 呼び出し側が書き換えても FLOW_TEMPLATES は変わらない。
 */
export function cloneFlowTemplate(key: FlowTemplateKey): FlowTemplate {
  return JSON.parse(JSON.stringify(FLOW_TEMPLATES[key])) as FlowTemplate;
}

/**
 * ホームキャンバスの既定の配置（設計書 §5.6）。`Canvas` の行が無い組織に返す（保存はしない）。
 * 線: 問い合わせ → 提案書 → 見積 → 請求、提案書 → 承認。
 */
export const DEFAULT_CANVAS_LAYOUT: CanvasLayout = {
  nodes: [
    { id: 'inquiry', label: '問い合わせ', icon: 'inbox', x: 0, y: 0, target: { kind: 'link', to: '/inbox' } },
    { id: 'proposal', label: '提案書', icon: 'file-text', x: 240, y: 0, target: { kind: 'template', templateKey: 'proposal' } },
    { id: 'estimate', label: '見積', icon: 'clipboard-list', x: 480, y: 0, target: { kind: 'template', templateKey: 'estimate' } },
    { id: 'invoice', label: '請求', icon: 'receipt', x: 720, y: 0, target: { kind: 'template', templateKey: 'invoice' } },
    { id: 'approvals', label: '承認', icon: 'check-square', x: 240, y: 160, target: { kind: 'link', to: '/inbox?tab=approvals' } },
    { id: 'cost', label: '原価', icon: 'hammer', x: 480, y: 160, target: { kind: 'link', to: '/accounting' } },
    { id: 'sns', label: 'SNS', icon: 'message-circle', x: 720, y: 160, target: { kind: 'template', templateKey: 'sns_post' } },
    { id: 'numbers', label: '数字', icon: 'chart-bar', x: 960, y: 160, target: { kind: 'link', to: '/dashboard' } },
  ],
  edges: [
    { from: 'inquiry', to: 'proposal' },
    { from: 'proposal', to: 'estimate' },
    { from: 'estimate', to: 'invoice' },
    { from: 'proposal', to: 'approvals' },
  ],
};

/** 既定の配置の深いコピー（呼び出し側が書き換えても定数は変わらない） */
export function defaultCanvasLayout(): CanvasLayout {
  return JSON.parse(JSON.stringify(DEFAULT_CANVAS_LAYOUT)) as CanvasLayout;
}
