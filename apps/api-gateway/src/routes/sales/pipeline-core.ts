/**
 * 営業パイプライン（商談ステージ）の純粋ロジック。
 *
 * prisma / fastify を import しない = DB 無しで単体テスト可能（sns の format.ts / calendar.ts と同じ方針）。
 * ルート実装（prisma 依存）は pipeline.ts。
 */

// ── 商談ステージ（リード→商談→提案→受注） ─────────────────────────
export const PIPELINE_STAGES = ['LEAD', 'NEGOTIATION', 'PROPOSAL', 'WON'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_LABEL: Record<PipelineStage, string> = {
  LEAD: 'リード',
  NEGOTIATION: '商談',
  PROPOSAL: '提案',
  WON: '受注',
};

/** 値が有効な商談ステージかどうかの型ガード。 */
export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (PIPELINE_STAGES as readonly string[]).includes(value);
}

/**
 * ステージ遷移が許可されるか。
 * 受注(WON)は終端ステージなので、そこから他ステージへは戻せない。
 * それ以外は前後どちらへの移動も許可（差し戻し・再交渉を想定）。
 */
export function canTransition(from: PipelineStage, to: PipelineStage): boolean {
  if (!isPipelineStage(from) || !isPipelineStage(to)) return false;
  if (from === 'WON' && to !== 'WON') return false;
  return true;
}

// ── Deal（商談） API レスポンス形 ───────────────────────────────
// 永続化は Prisma の Deal モデル（packages/db-schema）。DB では createdAt/updatedAt は DateTime だが、
// HTTP レスポンスでは Fastify が ISO 文字列にシリアライズする。この型はその API 契約を表す。
export interface Deal {
  id: string;
  orgId: string;
  title: string;
  company: string | null;
  amount: number;
  stage: PipelineStage;
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}
