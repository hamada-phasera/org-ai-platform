import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf } from '../tenancy';
import { requireAuth, requireOwner, requireUser, userOf } from '../middleware/auth';
import { MAX_ORGS_CREATED_PER_USER, countOrgsCreatedBy, createOrganizationFor } from '../services/organizations';
import { listActiveMemberships, loadUserProfile, signAccessToken } from '../services/memberships';
import { collectSetupStatus } from '../services/setup-status';
import { PLAN_LIMITS, storageQuotaBytes, usageState, type Plan } from '@org-ai/shared-types';
import { sendError } from '../utils/http-error';

const createOrgSchema = z.object({ name: z.string().trim().min(1).max(120) });

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
  /*
   * 組織を作る（設計書 UC1）。作った本人が OWNER になり、新しい組織用のトークンを返す（そのまま切り替わる）。
   * 組織を選ぶ前（所属なし）でも呼べるよう requireUser。
   * ⚠️ 作成できるのは1ユーザー MAX_ORGS_CREATED_PER_USER 組織まで（設計書 Q10 仮採用）。
   * ⚠️ トライアルは作成者ごとに1回（2つ目以降は課金を始めるまで梅の上限。Q3 仮採用。判定は billing）。
   */
  app.post('/', { preHandler: requireUser }, async (request, reply) => {
    const { sub } = userOf(request);
    const parsed = createOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', '組織名を入力してください');
    }
    if ((await countOrgsCreatedBy(sub)) >= MAX_ORGS_CREATED_PER_USER) {
      return sendError(
        reply,
        409,
        'ORG_LIMIT_REACHED',
        `作成できる組織は ${MAX_ORGS_CREATED_PER_USER} 個までです。追加が必要な場合はお問い合わせください。`,
      );
    }
    const profile = await loadUserProfile(sub);
    if (!profile) {
      return sendError(reply, 401, 'AUTH_REQUIRED', '認証が必要です');
    }
    const org = await createOrganizationFor(sub, parsed.data.name);
    const token = signAccessToken(app, { userId: sub, orgId: org.id, role: 'OWNER', email: profile.email });
    return reply.code(201).send({
      success: true,
      data: {
        token,
        organization: org,
        user: { ...profile, orgId: org.id, role: 'OWNER' },
        memberships: await listActiveMemberships(sub),
      },
    });
  });

  // 自組織情報取得
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const org = await db.organization.findUnique({
      where: { id: payload.orgId },
      select: {
        id: true,
        name: true,
        plan: true,
        billingEmail: true,
        createdAt: true,
        // 人数は「この組織の有効な所属」（User.orgId は最後に選んだ組織にすぎない）
        _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
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
        memberCount: org._count.memberships,
      },
    });
  });

  // 自組織情報更新（plan は更新不可）。
  // ⚠️ JWT の role では判定しない（E4）。降格された元オーナーがトークンの期限まで
  //    組織名や請求先を変えられてしまうため、DB を正本にする requireOwner を通す。
  app.patch('/me', { preHandler: requireOwner }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const result = updateOrgSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    const updated = await db.organization.update({
      where: { id: payload.orgId },
      data: result.data,
      select: { id: true, name: true, plan: true, billingEmail: true, createdAt: true },
    });
    return reply.send({ success: true, data: updated });
  });

  // 当月の利用量
  app.get('/me/usage', { preHandler: requireAuth }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const org = await db.organization.findUnique({
      where: { id: payload.orgId },
      select: { plan: true, storageUsedBytes: true, storageAddonUnits: true },
    });
    const plan = (org?.plan ?? 'STARTER') as Plan;
    const addonUnits = org?.storageAddonUnits ?? 0;
    const planLimit = PLAN_LIMITS[plan]?.aiCallsPerMonth ?? PLAN_LIMITS.STARTER.aiCallsPerMonth;

    const aiCallsThisMonth = await db.aILog.count({
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
