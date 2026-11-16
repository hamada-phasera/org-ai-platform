import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireOwner } from '../middleware/auth';
import { collectSetupStatus } from '../services/setup-status';
import { PLAN_LIMITS, storageQuotaBytes, usageState, type Plan } from '@org-ai/shared-types';
import { sendError } from '../utils/http-error';

const updateOrgSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  billingEmail: z.string().email().nullable().optional(),
});

function startOfMonthUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextMonthUTC(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  // 自組織情報取得
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const org = await prisma.organization.findUnique({
      where: { id: payload.orgId },
      select: {
        id: true,
        name: true,
        plan: true,
        billingEmail: true,
        createdAt: true,
        _count: { select: { users: true } },
      },
    });
    if (!org) {
      return sendError(reply, 404, 'NOT_FOUND', '組織が見つかりません');
    }
    return reply.send({
      success: true,
      data: {
        id: org.id,
        name: org.name,
        plan: org.plan,
        billingEmail: org.billingEmail,
        createdAt: org.createdAt,
        memberCount: org._count.users,
      },
    });
  });

  // 自組織情報更新（plan は更新不可）
  app.patch('/me', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string; role: string };
    if (payload.role !== 'OWNER') {
      return sendError(reply, 403, 'FORBIDDEN', 'この操作にはOWNER権限が必要です');
    }
    const result = updateOrgSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    const updated = await prisma.organization.update({
      where: { id: payload.orgId },
      data: result.data,
      select: { id: true, name: true, plan: true, billingEmail: true, createdAt: true },
    });
    return reply.send({ success: true, data: updated });
  });

  // 当月の利用量
  app.get('/me/usage', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const org = await prisma.organization.findUnique({
      where: { id: payload.orgId },
      select: { plan: true, storageUsedBytes: true, storageAddonUnits: true },
    });
    const plan = (org?.plan ?? 'STARTER') as Plan;
    const addonUnits = org?.storageAddonUnits ?? 0;
    const planLimit = PLAN_LIMITS[plan]?.aiCallsPerMonth ?? PLAN_LIMITS.STARTER.aiCallsPerMonth;

    const aiCallsThisMonth = await prisma.aILog.count({
      where: { orgId: payload.orgId, createdAt: { gte: startOfMonthUTC() } },
    });

    return reply.send({
      success: true,
      data: {
        aiCallsThisMonth,
        planLimit,
        // 上限を超えても止めない。ai-engine が軽いモデルに落として継続する
        state: usageState(aiCallsThisMonth, planLimit),
        resetAt: startOfNextMonthUTC().toISOString(),
        // BigInt は JSON にできない。容量は数GB規模なので Number で精度は落ちない
        storageUsedBytes: Number(org?.storageUsedBytes ?? 0),
        storageQuotaBytes: storageQuotaBytes(plan, addonUnits),
        storageAddonUnits: addonUnits,
        maxFileBytes: (PLAN_LIMITS[plan] ?? PLAN_LIMITS.STARTER).maxFileBytes,
      },
    });
  });

  /* 本番の設定が入っているか。
     ⚠️ オーナー専用。「トークンが未設定」のような情報は攻撃側にとって有用なので外には出さない。 */
  app.get('/me/setup', { preHandler: requireOwner }, async (_request, reply) => {
    return reply.send({ success: true, data: await collectSetupStatus() });
  });
}
