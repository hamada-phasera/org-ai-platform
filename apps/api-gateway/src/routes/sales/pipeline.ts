import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import { PIPELINE_STAGES, STAGE_LABEL, isPipelineStage, canTransition } from './pipeline-core';

/**
 * 営業パイプライン（商談ステージ）API。
 *
 * 商談は Prisma の Deal モデルに永続化する（従来のインメモリ Map から昇格。再起動でも消えない）。
 * ステージ値域の enforcement は zod + pipeline-core の PipelineStage で行う（DB は String カラム）。
 * ルート登録（index.ts の app.register）は統合フェーズ(B)が行う。prefix 例: `/api/sales/pipeline`。
 *
 * 純粋ロジック（ステージ/遷移/型）は pipeline-core.ts（DB 非依存・単体テスト可能）。
 */

// pipeline-core の型・ステージ・関数を再エクスポート（既存の import 経路を維持）。
export {
  PIPELINE_STAGES,
  STAGE_LABEL,
  isPipelineStage,
  canTransition,
  type PipelineStage,
  type Deal,
} from './pipeline-core';

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

    if (stage !== undefined && !isPipelineStage(stage)) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: `不正なステージ: ${stage}` } });
    }

    const deals = await prisma.deal.findMany({
      where: { orgId: payload.orgId, ...(stage !== undefined ? { stage } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send({ success: true, data: deals });
  });

  // 商談 詳細
  app.get('/:dealId', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const { dealId } = request.params as { dealId: string };
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal || deal.orgId !== payload.orgId) {
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
    const deal = await prisma.deal.create({
      data: {
        orgId: payload.orgId,
        title: parsed.data.title,
        company: parsed.data.company ?? null,
        amount: parsed.data.amount ?? 0,
        stage: parsed.data.stage ?? 'LEAD',
        ownerId: payload.sub ?? null,
      },
    });
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

    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal || deal.orgId !== payload.orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: '商談が見つかりません' } });
    }

    const { title, company, amount, stage } = parsed.data;
    // 現在ステージが不正値（DB は String なので理論上あり得る）でも安全に扱う。
    if (stage !== undefined && isPipelineStage(deal.stage) && !canTransition(deal.stage, stage)) {
      return reply.code(409).send({
        success: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `${STAGE_LABEL[deal.stage]}から${STAGE_LABEL[stage]}へは変更できません`,
        },
      });
    }

    const updated = await prisma.deal.update({
      where: { id: dealId },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(company !== undefined ? { company } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(stage !== undefined ? { stage } : {}),
      },
    });

    return reply.send({ success: true, data: updated });
  });
}
