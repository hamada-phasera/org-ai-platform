/**
 * SNS投稿のプラットフォーム別フォーマット & 検証（N-1 の純粋ロジック）。
 *
 * 共有型は未整備のためローカル定義（integration-requests に起票）。
 * このファイルは prisma / fastify を import しない = DB 無しで単体テスト可能。
 * ※ SNS への実投稿は一切行わない。ここは下書きの整形・検証のみ。
 */

export type SnsPlatform = 'twitter' | 'instagram' | 'linkedin';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 投稿下書き（Task.output に JSON で保存する形。フロントの deliverable 'sns' レンダラと一致）。 */
export interface SnsDraft {
  platform: SnsPlatform;
  content: string;
  /** 先頭 '#' を含まない素のタグ。UI 側が '#' を付与する。 */
  hashtags: string[];
  scheduledAt?: string;
  imageUrl?: string;
}

export interface PlatformConstraint {
  label: string;
  maxChars: number;
  /** ハッシュタグ数の上限。null は上限なし（X 等）。 */
  maxHashtags: number | null;
}

/** X(Twitter)=280 / Instagram=2200・タグ30 / LinkedIn=3000。フロント SNSPanel と一致。 */
export const PLATFORM_CONSTRAINTS: Record<SnsPlatform, PlatformConstraint> = {
  twitter: { label: 'X (Twitter)', maxChars: 280, maxHashtags: null },
  instagram: { label: 'Instagram', maxChars: 2200, maxHashtags: 30 },
  linkedin: { label: 'LinkedIn', maxChars: 3000, maxHashtags: null },
};

export function isSnsPlatform(value: unknown): value is SnsPlatform {
  return value === 'twitter' || value === 'instagram' || value === 'linkedin';
}

/**
 * ハッシュタグ整形: 先頭 '#' 除去 / 空白・不可文字除去 / 空要素除去 / 重複除去（大文字小文字無視）。
 * 返り値は先頭 '#' なしの素のタグ配列。
 */
export function normalizeHashtags(input: readonly (string | null | undefined)[] | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    // 先頭の連続する '#' を除去し、空白を全除去、ハッシュタグに使えない記号を除去。
    const cleaned = raw
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '')
      .replace(/[^\p{L}\p{N}_]/gu, '');
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/** 文字数カウント: 本文 + Σ(タグ長 + 2)。+2 は '#' と区切り空白（フロント SNSPanel と一致）。 */
export function countChars(content: string, hashtags: readonly string[]): number {
  return content.length + hashtags.reduce((sum, t) => sum + t.length + 2, 0);
}

export interface PostValidation {
  platform: SnsPlatform;
  ok: boolean;
  charCount: number;
  maxChars: number;
  overBy: number;
  hashtagCount: number;
  maxHashtags: number | null;
}

/** プラットフォーム制約に対する下書きの検証（超過は overBy>0 / タグ上限超過で ok=false）。 */
export function validatePost(
  platform: SnsPlatform,
  content: string,
  hashtags: readonly string[],
): PostValidation {
  const c = PLATFORM_CONSTRAINTS[platform];
  const charCount = countChars(content, hashtags);
  const hashtagCount = hashtags.length;
  const overChars = charCount > c.maxChars;
  const overTags = c.maxHashtags !== null && hashtagCount > c.maxHashtags;
  return {
    platform,
    ok: !overChars && !overTags,
    charCount,
    maxChars: c.maxChars,
    overBy: Math.max(0, charCount - c.maxChars),
    hashtagCount,
    maxHashtags: c.maxHashtags,
  };
}

/** コピー用の文字列（本文 + 改行2 + '#'付きタグ）。SNSPanel.handleCopy と一致。 */
export function formatForClipboard(content: string, hashtags: readonly string[]): string {
  if (hashtags.length === 0) return content;
  return `${content}\n\n${hashtags.map((t) => `#${t}`).join(' ')}`;
}

export interface SnsGenInputs {
  topic: string;
  tone?: string;
  keywords?: string;
  hashtagCount?: number;
}

/**
 * /llm/chat 用の messages を組み立てる（純粋関数, json_mode 前提で JSON 出力を指示）。
 * プラットフォームの文字数上限を system に明示し、モデルに厳守させる。
 */
export function buildSnsMessages(platform: SnsPlatform, inputs: SnsGenInputs): ChatMessage[] {
  const c = PLATFORM_CONSTRAINTS[platform];
  const tagCap = c.maxHashtags === null ? '本文に自然に溶け込む数（3〜5個目安）' : `最大${c.maxHashtags}個`;
  const wantTags = inputs.hashtagCount ?? (c.maxHashtags === null ? 4 : 8);

  const system = [
    `あなたは中小企業向けの ${c.label} 投稿を作成する SNS マーケ担当です。`,
    `${c.label} の下書きを1本、日本語で作成してください。本文は ${c.maxChars} 文字以内。`,
    `ハッシュタグは ${tagCap}。ハッシュタグは先頭の「#」を付けず素の語で返してください。`,
    '誇大表現・未確認の数値・個人情報は書かないこと。',
    '',
    '出力は次の JSON のみ（前後に説明を付けない）:',
    '{"content": "投稿本文", "hashtags": ["タグ1", "タグ2"]}',
  ].join('\n');

  const userLines = [`テーマ: ${inputs.topic}`];
  if (inputs.tone) userLines.push(`トーン: ${inputs.tone}`);
  if (inputs.keywords) userLines.push(`盛り込みたい要素: ${inputs.keywords}`);
  userLines.push(`希望ハッシュタグ数: 約${wantTags}個`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ];
}
