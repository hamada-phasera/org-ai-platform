import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import { COST_CATEGORIES, splitTaxInclusive } from './accounting-core';
import { AuthPayload, fail, parseDateOnly, toDateOnly } from './shared';

/**
 * 原価明細（CostEntry）API。prefix: `/api/accounting/costs`
 *
 * status=DRAFT は「AI が読み取ったが人が未確認」。チャットや LINE から入ってきた明細は
 * ここに DRAFT で積まれ、人が確認して CONFIRMED にする。台帳の確定値は CONFIRMED だけを見る。
 * 外部送信と同じで、**AI が読んだ数字をそのまま確定値にしない**のがこの設計の要点。
 */

const CATEGORY_VALUES = COST_CATEGORIES;
const SOURCES = ['MANUAL', 'CHAT', 'LINE'] as const;
const STATUSES = ['DRAFT', 'CONFIRMED'] as const;

const money = z.number().int().min(0).max(999_999_999_999);

const baseFields = {
  projectId: z.string().min(1),
  vendorId: z.string().min(1).nullable().optional(),
  incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式で指定してください'),
  category: z.enum(CATEGORY_VALUES),
  description: z.string().max(500).nullable().optional(),
  source: z.enum(SOURCES).optional(),
  status: z.enum(STATUSES).optional(),
};

/**
 * 金額は「税抜＋消費税」か「税込」のどちらかで受ける。
 * 領収書は税込しか分からないことが多く、そこで割り戻しを画面に押し付けると入力が続かない。
 * 受け取った側（ここ）で一度だけ分ける。
 */
const amountSchema = z
  .object({
    amount: money.optional(),
    taxAmount: money.optional(),
    /** 税込金額。指定すると amount/taxAmount は無視して割り戻す */
    amountIncludingTax: money.optional(),
  })
  .refine((v) => v.amount !== undefined || v.amountIncludingTax !== undefined, {
    message: 'amount（税抜）か amountIncludingTax（税込）のどちらかが必要です',
  });

const createSchema = z.object(baseFields).and(amountSchema);

const updateSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(baseFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
    ),
    amount: money.optional(),
    taxAmount: money.optional(),
    amountIncludingTax: money.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '更新する項目がありません' });

const confirmSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

/** 税込で来たら分解し、税抜で来たらそのまま。どちらでもなければ触らない。 */
function resolveAmounts(input: {
  amount?: number;
  taxAmount?: number;
  amountIncludingTax?: number;
}): { amount?: number; taxAmount?: number } {
  if (input.amountIncludingTax !== undefined) {
    return splitTaxInclusive(input.amountIncludingTax);
  }
  const out: { amount?: number; taxAmount?: number } = {};
  if (input.amount !== undefined) out.amount = input.amount;
  if (input.taxAmount !== undefined) out.taxAmount = input.taxAmount;
  return out;
}

export async function accountingCostsRoutes(app: FastifyInstance): Promise<void> {
  // 一覧。既定は新しい順。?status=DRAFT で承認待ちだけを出す
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { projectId, status, from, to, limit } = request.query as Record<string, string | undefined>;

    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
      return fail(reply, 400, 'VALIDATION_ERROR', `不正なステータス: ${status}`);
    }
    const fromDate = from ? parseDateOnly(from) : null;
    const toDate = to ? parseDateOnly(to) : null;
    if ((from && !fromDate) || (to && !toDate)) {
      return fail(reply, 400, 'VALIDATION_ERROR', '期間は YYYY-MM-DD 形式で指定してください');
    }

    const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const entries = await prisma.costEntry.findMany({
      where: {
        orgId,
        ...(projectId ? { projectId } : {}),
        ...(status ? { status } : {}),
        ...(fromDate || toDate
          ? { incurredOn: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
          : {}),
      },
      orderBy: [{ incurredOn: 'desc' }, { createdAt: 'desc' }],
      take,
      include: {
        project: { select: { id: true, code: true, name: true } },
        vendor: { select: { id: true, name: true, kind: true, invoiceRegistered: true } },
      },
    });

    return reply.send({
      success: true,
      data: entries.map((e) => ({ ...e, incurredOn: toDateOnly(e.incurredOn) })),
    });
  });

  // 作成
  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    const body = parsed.data;
    const incurredOn = parseDateOnly(body.incurredOn);
    if (!incurredOn) return fail(reply, 400, 'VALIDATION_ERROR', 'incurredOn が不正な日付です');

    // 他 org の工事・取引先に紐付けさせない
    const project = await prisma.project.findFirst({
      where: { id: body.projectId, orgId: payload.orgId },
      select: { id: true },
    });
    if (!project) return fail(reply, 404, 'NOT_FOUND', '工事が見つかりません');

    if (body.vendorId) {
      const vendor = await prisma.vendor.findFirst({
        where: { id: body.vendorId, orgId: payload.orgId },
        select: { id: true },
      });
      if (!vendor) return fail(reply, 404, 'NOT_FOUND', '取引先が見つかりません');
    }

    const amounts = resolveAmounts(body);
    const entry = await prisma.costEntry.create({
      data: {
        orgId: payload.orgId,
        projectId: body.projectId,
        vendorId: body.vendorId ?? null,
        incurredOn,
        category: body.category,
        amount: amounts.amount ?? 0,
        taxAmount: amounts.taxAmount ?? 0,
        description: body.description ?? null,
        source: body.source ?? 'MANUAL',
        status: body.status ?? 'DRAFT',
        createdBy: payload.sub ?? null,
      },
    });
    return reply.code(201).send({ success: true, data: { ...entry, incurredOn: toDateOnly(entry.incurredOn) } });
  });

  // 更新（承認＝status を CONFIRMED にするのもここ）
  app.patch('/:costId', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { costId } = request.params as { costId: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    const body = parsed.data as Record<string, unknown> & {
      incurredOn?: string;
      projectId?: string;
      vendorId?: string | null;
    };

    const existing = await prisma.costEntry.findFirst({ where: { id: costId, orgId } });
    if (!existing) return fail(reply, 404, 'NOT_FOUND', '原価明細が見つかりません');

    const data: Record<string, unknown> = {};
    for (const k of ['category', 'description', 'source', 'status'] as const) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    if (body.incurredOn !== undefined) {
      const d = parseDateOnly(body.incurredOn);
      if (!d) return fail(reply, 400, 'VALIDATION_ERROR', 'incurredOn が不正な日付です');
      data.incurredOn = d;
    }
    if (body.projectId !== undefined) {
      const project = await prisma.project.findFirst({ where: { id: body.projectId, orgId }, select: { id: true } });
      if (!project) return fail(reply, 404, 'NOT_FOUND', '工事が見つかりません');
      data.projectId = body.projectId;
    }
    if (body.vendorId !== undefined) {
      if (body.vendorId === null) {
        data.vendorId = null;
      } else {
        const vendor = await prisma.vendor.findFirst({ where: { id: body.vendorId, orgId }, select: { id: true } });
        if (!vendor) return fail(reply, 404, 'NOT_FOUND', '取引先が見つかりません');
        data.vendorId = body.vendorId;
      }
    }
    const amounts = resolveAmounts(parsed.data);
    if (amounts.amount !== undefined) data.amount = amounts.amount;
    if (amounts.taxAmount !== undefined) data.taxAmount = amounts.taxAmount;

    const entry = await prisma.costEntry.update({ where: { id: costId }, data });
    return reply.send({ success: true, data: { ...entry, incurredOn: toDateOnly(entry.incurredOn) } });
  });

  // まとめて確定（承認画面の「選択したものを確定」）
  app.post('/confirm', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const parsed = confirmSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    // orgId を where に含めるので、他 org の id が混ざっていても黙って対象外になる
    const result = await prisma.costEntry.updateMany({
      where: { id: { in: parsed.data.ids }, orgId, status: 'DRAFT' },
      data: { status: 'CONFIRMED' },
    });
    return reply.send({ success: true, data: { confirmed: result.count } });
  });

  app.delete('/:costId', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { costId } = request.params as { costId: string };
    const existing = await prisma.costEntry.findFirst({ where: { id: costId, orgId }, select: { id: true } });
    if (!existing) return fail(reply, 404, 'NOT_FOUND', '原価明細が見つかりません');
    await prisma.costEntry.delete({ where: { id: costId } });
    return reply.send({ success: true, data: { id: costId } });
  });
}
