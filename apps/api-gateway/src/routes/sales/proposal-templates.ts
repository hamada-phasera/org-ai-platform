/**
 * 提案書テンプレート & プロンプト組み立て（S-3 の純粋ロジック）。
 *
 * 型の正本は `@org-ai/shared-types` の `ProposalTemplate` / `ProposalSection`
 * （integration-requests 営業#4 を消化）。
 * このファイルは prisma / fastify を import しない = DB 無しで単体テスト可能。
 */
import type { ProposalTemplate, ProposalSection } from '@org-ai/shared-types';

export type { ProposalTemplate, ProposalSection };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 提案の入力（顧客・背景・要件など）。すべて任意だが customerName は実質必須。 */
export interface ProposalInputs {
  customerName: string;
  background?: string;
  requirements?: string;
  budget?: string;
}

/** 組み込みテンプレート（R1/R2 の暫定。将来は DB/shared-types へ）。 */
export const PROPOSAL_TEMPLATES: ProposalTemplate[] = [
  {
    id: 'standard',
    name: '標準提案書',
    tone: 'formal',
    language: 'ja',
    sections: [
      { key: 'summary', title: 'エグゼクティブサマリー', guidance: '提案の要点を3〜4行で。' },
      { key: 'challenge', title: '課題認識', guidance: '顧客の背景・課題を具体的に言語化する。' },
      { key: 'proposal', title: 'ご提案内容', guidance: '解決策と提供価値を箇条書き中心で。' },
      { key: 'effect', title: '期待効果', guidance: '定量・定性の効果を分けて記載。数値は仮定と明記。' },
      { key: 'schedule', title: '導入スケジュール', guidance: '大まかなフェーズと期間の目安。' },
      { key: 'price', title: '概算費用', guidance: '価格は「要お見積り」とし確定値は書かない。' },
    ],
  },
  {
    id: 'short',
    name: '要約提案（1枚）',
    tone: 'casual',
    language: 'ja',
    sections: [
      { key: 'challenge', title: '課題', guidance: '1〜2文で。' },
      { key: 'proposal', title: '提案', guidance: '要点を3つまで。' },
      { key: 'nextstep', title: '次のステップ', guidance: '打ち合わせ日程調整などの提案で締める。' },
    ],
  },
];

export const DEFAULT_TEMPLATE_ID = 'standard';

/** id からテンプレートを取得（見つからなければ undefined）。 */
export function getTemplate(id?: string): ProposalTemplate | undefined {
  return PROPOSAL_TEMPLATES.find((t) => t.id === (id ?? DEFAULT_TEMPLATE_ID));
}

/**
 * テンプレート + 入力から /llm/chat 用の messages を組み立てる（純粋関数）。
 * 価格の確定値を出さない・不明点は仮定と明記する等のガードを system に含める。
 */
export function buildProposalMessages(template: ProposalTemplate, inputs: ProposalInputs): ChatMessage[] {
  const toneNote =
    template.tone === 'formal' ? '文体は敬体（です・ます）でフォーマルに。' : '文体は親しみやすく簡潔に。';

  const sectionSpec = template.sections
    .map((s, i) => `${i + 1}. ${s.title} — ${s.guidance}`)
    .join('\n');

  const system = [
    'あなたは中小企業向けの営業提案書を作成するアシスタントです。',
    `顧客「${inputs.customerName}」向けの提案書ドラフトを日本語のMarkdownで作成してください。`,
    toneNote,
    '各章は指定の見出し(##)で構成し、事実が不明な箇所は憶測で断定せず「（要確認）」と明記します。',
    '金額の確定値・具体的な個人情報は記載しません。',
    '',
    '# 章構成',
    sectionSpec,
  ].join('\n');

  const userLines = [`顧客名: ${inputs.customerName}`];
  if (inputs.background) userLines.push(`背景・状況: ${inputs.background}`);
  if (inputs.requirements) userLines.push(`要望・要件: ${inputs.requirements}`);
  if (inputs.budget) userLines.push(`予算感: ${inputs.budget}`);
  userLines.push('', '上記を踏まえ、章構成に沿った提案書ドラフトを作成してください。');

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ];
}
