import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';

/**
 * 営業パイプライン（商談ステージ）最小API — R1 縦切り。
 *
 * 共有の Deal / PipelineStage 型や Prisma モデルはまだ存在しないため（B=統合フェーズで正式化）、
 * ここではローカル型 + orgId 単位のインメモリストアで暫定実装する。
 * schema 化の要求は docs/integration-requests.md #1 に起票済み。
 *
 * ルート登録（index.ts の app.register）は統合フェーズ(B)が行う。
 * 本ファイルは prisma を import しない（DATABASE_URL 依存を持たず、DB 無しで単体テスト可能）。
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

// ── Deal（商談） ───────────────────────────────────────────────
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

// ── インメモリストア（orgId 単位。テナント分離を保つ） ───────────────
const dealsByOrg = new Map<string, Deal[]>();

function orgDeals(orgId: string): Deal[] {
  let deals = dealsByOrg.get(orgId);
  if (!deals) {
    deals = [];
    dealsByOrg.set(orgId, deals);
  }
  return deals;
}

/** テスト用: ストアを初期化する。 */
export function _resetPipelineStore(): void {
  dealsByOrg.clear();
}

// ── バリデーション（zod。既存ルート規約に合わせる） ─────────────────
const createDealSchema = z.object({
  title: z.string().min(1).max(200),
  company: z.string().max(200).nullable().optional(),
  amount: z.number().int().min(0).optional(),
  stage: z.enum(PIPELINE_STAGES).optional(),
});

const updateDealSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    company: z.string().max(200).nullable().optional(),
    amount: z.number().int().min(0).optional(),
    stage: z.enum(PIPELINE_STAGES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '更新する項目がありません' });

type AuthPayload = { orgId: string; sub?: string };

/**
 * 営業パイプライン ルートプラグイン。
 * 登録時 prefix 例: `/api/sales/pipeline`（B が index.ts で app.register する）。
 */
export async function salesPipelineRoutes(app: FastifyInstance): Promise<void> {
  // 商談一覧（?stage= で絞り込み可）
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { stage } = request.query as { stage?: string };

    let deals = orgDeals(payload.orgId);
    if (stage !== undefined) {
      if (!isPipelineStage(stage)) {
        return reply
          .code(400)
          .send({ success: false, error: { code: 'VALIDATION_ERROR', message: `不正なステージ: ${stage}` } });
      }
      deals = deals.filter((d) => d.stage === stage);
    }
    return reply.send({ success: true, data: deals });
  });

  // 商談 詳細
  app.get('/:dealId', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { dealId } = request.params as { dealId: string };
    const deal = orgDeals(payload.orgId).find((d) => d.id === dealId);
    if (!deal) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: '商談が見つかりません' } });
    }
    return reply.send({ success: true, data: deal });
  });

  // 商談 作成
  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = createDealSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const now = new Date().toISOString();
    const deal: Deal = {
      id: randomUUID(),
      orgId: payload.orgId,
      title: parsed.data.title,
      company: parsed.data.company ?? null,
      amount: parsed.data.amount ?? 0,
      stage: parsed.data.stage ?? 'LEAD',
      ownerId: payload.sub ?? null,
      createdAt: now,
      updatedAt: now,
    };
    orgDeals(payload.orgId).push(deal);
    return reply.code(201).send({ success: true, data: deal });
  });

  // 商談 更新（ステージ移動・金額など）
  app.patch('/:dealId', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { dealId } = request.params as { dealId: string };
    const parsed = updateDealSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const deal = orgDeals(payload.orgId).find((d) => d.id === dealId);
    if (!deal) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: '商談が見つかりません' } });
    }

    const { title, company, amount, stage } = parsed.data;
    if (stage !== undefined && !canTransition(deal.stage, stage)) {
      return reply.code(409).send({
        success: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `${STAGE_LABEL[deal.stage]}から${STAGE_LABEL[stage]}へは変更できません`,
        },
      });
    }

    if (title !== undefined) deal.title = title;
    if (company !== undefined) deal.company = company;
    if (amount !== undefined) deal.amount = amount;
    if (stage !== undefined) deal.stage = stage;
    deal.updatedAt = new Date().toISOString();

    return reply.send({ success: true, data: deal });
  });
}
