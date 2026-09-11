import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';
import { PLAN_LIMITS, storageQuotaBytes, type Plan } from '@org-ai/shared-types';

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
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: '組織が見つかりません' },
      });
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
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'この操作にはOWNER権限が必要です' },
      });
    }
    const result = updateOrgSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: result.error.message },
      });
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
        resetAt: startOfNextMonthUTC().toISOString(),
        // BigInt は JSON にできない。容量は数GB規模なので Number で精度は落ちない
        storageUsedBytes: Number(org?.storageUsedBytes ?? 0),
        storageQuotaBytes: storageQuotaBytes(plan, addonUnits),
        storageAddonUnits: addonUnits,
        maxFileBytes: (PLAN_LIMITS[plan] ?? PLAN_LIMITS.STARTER).maxFileBytes,
      },
    });
  });
}
