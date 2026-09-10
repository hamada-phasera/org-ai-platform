import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import {
  PROJECT_STATUSES,
  emptyTotals,
  summarizeProject,
  type CategoryTotals,
  type CostCategory,
  COST_CATEGORIES,
} from './accounting-core';
import { AuthPayload, fail, isUniqueViolation, parseDateOnly, toDateOnly } from './shared';

/**
 * 工事台帳（Project）API。prefix: `/api/accounting/projects`
 *
 * 一覧は「工事ごとの原価実績」を必ず一緒に返す。金額を見ずに工事名だけ並べても
 * 経理の役に立たないため。N+1 を避けるため原価は groupBy で1クエリにまとめる。
 */

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式で指定してください')
  .nullable()
  .optional();

/**
 * 金額の上限。
 * ⚠️ DB は INTEGER（int4）なので、これを超える値を通すと Postgres が 22003 を投げ、
 *    日本語の 400 ではなく 500 になる。列の型と必ず揃えること。
 */
const money = z.number().int().min(0).max(2_147_483_647);

const createSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  client: z.string().max(200).nullable().optional(),
  contractAmount: money.optional(),
  startOn: dateOnly,
  dueOn: dateOnly,
  status: z.enum(PROJECT_STATUSES).optional(),
  budgetMaterial: money.optional(),
  budgetLabor: money.optional(),
  budgetSubcon: money.optional(),
  budgetOther: money.optional(),
  progressRate: z.number().int().min(0).max(100).optional(),
  note: z.string().max(2000).nullable().optional(),
});

const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: '更新する項目がありません',
});

/** 日付文字列を Date に直す。不正な日付はここで例外にせず null を返し、呼び出し側が 400 にする。 */
function toDates(input: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; field: string } {
  const out = { ...input };
  for (const field of ['startOn', 'dueOn'] as const) {
    const raw = out[field];
    if (raw === undefined) continue;
    if (raw === null) continue;
    const d = parseDateOnly(String(raw));
    if (!d) return { ok: false, field };
    out[field] = d;
  }
  return { ok: true, value: out };
}

/** 工事ごと・費目ごとの原価合計を1クエリで取る（工事が何十件あっても2クエリで済ませる）。 */
async function actualsByProject(
  orgId: string,
  projectIds: string[],
  confirmedOnly: boolean,
): Promise<Map<string, CategoryTotals>> {
  const map = new Map<string, CategoryTotals>();
  if (projectIds.length === 0) return map;
  const rows = await prisma.costEntry.groupBy({
    by: ['projectId', 'category'],
    where: {
      orgId,
      projectId: { in: projectIds },
      ...(confirmedOnly ? { status: 'CONFIRMED' } : {}),
    },
    _sum: { amount: true },
  });
  for (const r of rows) {
    const totals = map.get(r.projectId) ?? emptyTotals();
    const key = (COST_CATEGORIES as readonly string[]).includes(r.category)
      ? (r.category as CostCategory)
      : 'OTHER';
    totals[key] += r._sum.amount ?? 0;
    map.set(r.projectId, totals);
  }
  return map;
}

export async function accountingProjectsRoutes(app: FastifyInstance): Promise<void> {
  // 一覧（収支つき）
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { status, includeDraft } = request.query as { status?: string; includeDraft?: string };

    if (status !== undefined && !(PROJECT_STATUSES as readonly string[]).includes(status)) {
      return fail(reply, 400, 'VALIDATION_ERROR', `不正な工事ステータス: ${status}`);
    }

    const projects = await prisma.project.findMany({
      where: { orgId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    /* ⚠️ 既定は確定分のみ。画面が「確定したものだけが台帳の数字になります」と
       言っている以上、既定が DRAFT 込みだと承認操作が無意味に見える
       （承認しても数字が1円も動かない）。未確認込みで見たいときは明示的に頼む。 */
    const actuals = await actualsByProject(
      orgId,
      projects.map((p) => p.id),
      includeDraft !== 'true',
    );

    const data = projects.map((p) => {
      const costs = actuals.get(p.id) ?? emptyTotals();
      // summarizeProject は明細の配列を取るので、集計済みの値を明細1件ずつに見立てて渡す
      const summary = summarizeProject(
        p,
        COST_CATEGORIES.map((c) => ({ category: c, amount: costs[c] })),
      );
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        client: p.client,
        status: p.status,
        progressRate: p.progressRate,
        startOn: toDateOnly(p.startOn),
        dueOn: toDateOnly(p.dueOn),
        note: p.note,
        ...summary,
      };
    });
    return reply.send({ success: true, data });
  });

  // 詳細（原価明細つき）
  app.get('/:projectId', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { projectId } = request.params as { projectId: string };
    const { includeDraft } = request.query as { includeDraft?: string };

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return fail(reply, 404, 'NOT_FOUND', '工事が見つかりません');

    const entries = await prisma.costEntry.findMany({
      where: { orgId, projectId },
      orderBy: { incurredOn: 'desc' },
      include: { vendor: { select: { id: true, name: true, kind: true, invoiceRegistered: true } } },
    });

    // ⚠️ 一覧と同じ条件で集計する。ここだけ DRAFT 込み固定にすると、
    //    同じ工事の粗利率が一覧と詳細で食い違う
    const summary = summarizeProject(project, entries, includeDraft !== 'true');
    return reply.send({
      success: true,
      data: {
        ...project,
        startOn: toDateOnly(project.startOn),
        dueOn: toDateOnly(project.dueOn),
        ...summary,
        costEntries: entries.map((e) => ({ ...e, incurredOn: toDateOnly(e.incurredOn) })),
      },
    });
  });

  // 作成
  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    const dates = toDates(parsed.data);
    if (!dates.ok) return fail(reply, 400, 'VALIDATION_ERROR', `${dates.field} が不正な日付です`);

    try {
      const project = await prisma.project.create({
        data: { ...(dates.value as object), orgId } as never,
      });
      return reply.code(201).send({ success: true, data: project });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return fail(reply, 409, 'CONFLICT', `工事番号「${parsed.data.code}」は既に使われています`);
      }
      throw e;
    }
  });

  // 更新
  app.patch('/:projectId', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { projectId } = request.params as { projectId: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    const dates = toDates(parsed.data);
    if (!dates.ok) return fail(reply, 400, 'VALIDATION_ERROR', `${dates.field} が不正な日付です`);

    // 他 org の工事を id 指定で書き換えられないよう、必ず orgId ごと確認してから更新する
    const existing = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!existing) return fail(reply, 404, 'NOT_FOUND', '工事が見つかりません');

    try {
      const project = await prisma.project.update({
        where: { id: projectId },
        data: dates.value as never,
      });
      return reply.send({ success: true, data: project });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return fail(reply, 409, 'CONFLICT', `工事番号「${parsed.data.code}」は既に使われています`);
      }
      throw e;
    }
  });

  // 削除。原価明細が残っている工事は消させない
  // （CostEntry は CASCADE で一緒に消えるため、金額の履歴が黙って失われる）
  app.delete('/:projectId', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { projectId } = request.params as { projectId: string };

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return fail(reply, 404, 'NOT_FOUND', '工事が見つかりません');

    const costCount = await prisma.costEntry.count({ where: { orgId, projectId } });
    if (costCount > 0) {
      return fail(
        reply,
        409,
        'CONFLICT',
        `この工事には原価明細が ${costCount} 件あります。先に明細を削除してください。`,
      );
    }

    await prisma.project.delete({ where: { id: projectId } });
    return reply.send({ success: true, data: { id: projectId } });
  });
}
