import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import { VENDOR_KINDS, estimateInvoiceImpact } from './accounting-core';
import { AuthPayload, fail, isUniqueViolation, jstToday, parseDateOnly } from './shared';

/**
 * 取引先・インボイス（Vendor）API。prefix: `/api/accounting/vendors`
 *
 * ここが FLOW 固有の価値になる部分。会計ソフトは仕訳を持つが、
 * 「誰が適格請求書発行事業者として登録していて、未登録の相手にいくら払っていて、
 * 経過措置が下がると負担がいくら増えるか」という台帳は持っていない。
 *
 * 登録番号は T + 13桁。形式は検証するが、**実在確認（国税庁の公表サイト照会）はしない**。
 * 照合したい場合はチャットからカスタム HTTP ノードとして繋ぐ（専用実装を持たない）。
 */

const INVOICE_NUMBER_RE = /^T\d{13}$/;

const baseSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(VENDOR_KINDS).optional(),
  invoiceRegistered: z.boolean().optional(),
  invoiceNumber: z
    .string()
    .regex(INVOICE_NUMBER_RE, '登録番号は T のあと数字13桁で入力してください')
    .nullable()
    .optional(),
  note: z.string().max(2000).nullable().optional(),
});

const updateSchema = baseSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: '更新する項目がありません' });

export async function accountingVendorsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 一覧。既定で「直近12ヶ月の取引額」を一緒に返す。
   * 登録の有無だけ並べても判断できず、金額が横に無いと「どこから手を付けるか」が決まらないため。
   */
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { since } = request.query as { since?: string };

    const sinceDate = since ? parseDateOnly(since) : null;
    if (since && !sinceDate) {
      return fail(reply, 400, 'VALIDATION_ERROR', 'since は YYYY-MM-DD 形式で指定してください');
    }

    const vendors = await prisma.vendor.findMany({ where: { orgId }, orderBy: { name: 'asc' } });

    const totals = await prisma.costEntry.groupBy({
      by: ['vendorId'],
      where: {
        orgId,
        vendorId: { not: null },
        // インボイスの判断材料なので確定分だけを出す（試算と数字を揃える）
        status: 'CONFIRMED',
        ...(sinceDate ? { incurredOn: { gte: sinceDate } } : {}),
      },
      _sum: { amount: true, taxAmount: true },
      _count: { _all: true },
    });
    const byVendor = new Map(totals.map((t) => [t.vendorId as string, t]));

    const data = vendors.map((v) => {
      const t = byVendor.get(v.id);
      return {
        ...v,
        stats: {
          entryCount: t?._count._all ?? 0,
          amount: t?._sum.amount ?? 0,
          taxAmount: t?._sum.taxAmount ?? 0,
        },
      };
    });
    return reply.send({ success: true, data });
  });

  /**
   * インボイス経過措置の影響サマリ。
   * 未登録の取引先に払っている消費税額を集計し、次の切り替えで増える負担を試算する。
   */
  app.get('/invoice-impact', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { since } = request.query as { since?: string };

    const sinceDate = since ? parseDateOnly(since) : null;
    if (since && !sinceDate) {
      return fail(reply, 400, 'VALIDATION_ERROR', 'since は YYYY-MM-DD 形式で指定してください');
    }

    const unregistered = await prisma.vendor.findMany({
      where: { orgId, invoiceRegistered: false },
      select: { id: true, name: true, kind: true },
    });

    // ⚠️ 未登録先が0社でも、取引先が紐付いていない明細の件数は返す。
    //    未紐付けの明細こそ未登録業者が隠れている側なので、
    //    ここで早期 return すると「出したい場面で警告が出ない」ことになる。
    const unlinked = await prisma.costEntry.count({
      where: {
        orgId,
        vendorId: null,
        status: 'CONFIRMED',
        ...(sinceDate ? { incurredOn: { gte: sinceDate } } : {}),
      },
    });

    if (unregistered.length === 0) {
      return reply.send({
        success: true,
        data: {
          impact: estimateInvoiceImpact(0, jstToday()),
          unregisteredVendors: [],
          unlinkedCostEntryCount: unlinked,
        },
      });
    }

    const totals = await prisma.costEntry.groupBy({
      by: ['vendorId'],
      where: {
        orgId,
        vendorId: { in: unregistered.map((v) => v.id) },
        // ⚠️ 確定分だけで試算する。DRAFT を含めると、AI が1枚読み違えただけで
        //    「切り替えで増える負担」の円表示が人の承認前に動く
        status: 'CONFIRMED',
        ...(sinceDate ? { incurredOn: { gte: sinceDate } } : {}),
      },
      _sum: { amount: true, taxAmount: true },
    });
    const byVendor = new Map(totals.map((t) => [t.vendorId as string, t]));

    const rows = unregistered
      .map((v) => {
        const t = byVendor.get(v.id);
        return {
          id: v.id,
          name: v.name,
          kind: v.kind,
          amount: t?._sum.amount ?? 0,
          taxAmount: t?._sum.taxAmount ?? 0,
        };
      })
      .sort((a, b) => b.taxAmount - a.taxAmount);

    const totalTax = rows.reduce((sum, r) => sum + r.taxAmount, 0);

    return reply.send({
      success: true,
      data: {
        impact: estimateInvoiceImpact(totalTax, jstToday()),
        unregisteredVendors: rows,
        unlinkedCostEntryCount: unlinked,
      },
    });
  });

  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const parsed = baseSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }
    try {
      const vendor = await prisma.vendor.create({ data: { ...parsed.data, orgId } });
      return reply.code(201).send({ success: true, data: vendor });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return fail(reply, 409, 'CONFLICT', `取引先「${parsed.data.name}」は既に登録されています`);
      }
      throw e;
    }
  });

  app.patch('/:vendorId', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { vendorId } = request.params as { vendorId: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, 'VALIDATION_ERROR', parsed.error.errors[0]?.message ?? '入力が不正です');
    }

    const existing = await prisma.vendor.findFirst({ where: { id: vendorId, orgId }, select: { id: true } });
    if (!existing) return fail(reply, 404, 'NOT_FOUND', '取引先が見つかりません');

    try {
      const vendor = await prisma.vendor.update({ where: { id: vendorId }, data: parsed.data });
      return reply.send({ success: true, data: vendor });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return fail(reply, 409, 'CONFLICT', `取引先「${parsed.data.name}」は既に登録されています`);
      }
      throw e;
    }
  });

  // 取引先を消しても原価明細は残る（vendorId は SET NULL）。金額の履歴は失わない
  app.delete('/:vendorId', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as AuthPayload;
    const { vendorId } = request.params as { vendorId: string };
    const existing = await prisma.vendor.findFirst({ where: { id: vendorId, orgId }, select: { id: true } });
    if (!existing) return fail(reply, 404, 'NOT_FOUND', '取引先が見つかりません');
    await prisma.vendor.delete({ where: { id: vendorId } });
    return reply.send({ success: true, data: { id: vendorId } });
  });
}
