// データノードの資源ごとのアダプタ（docs/design/canvas-home.md §6.5・T14）。すべて tenantDb。列も操作も許可リスト。
//
// ■ 列・操作の許可リストは shared-types の FLOW_DATA_RESOURCES（保存時の検証と同じ表）。ここに無い表は読めない。
// ■ cost_entry は必ず status='DRAFT'（AI が読んだ数字は下書き。人が承認して CONFIRMED にするまで台帳に載らない）。
//   金額は税抜（amount）と消費税（taxAmount）を分けて受ける。一律 10% と仮定して割り戻さない。
// ■ 参照（projectId / vendorId）は assertSameOrg で同じ組織か確かめる。
// ■ 並びは新しい順で固定。where は等値だけ。

import { FLOW_DATA_RESOURCES, type FlowDataOp, type FlowDataResource } from '@org-ai/shared-types';
import type { TenantDb } from '../../tenancy/tenant-db';
import { assertSameOrg } from '../../tenancy';
import { PIPELINE_STAGES } from '../../routes/sales/pipeline-core';
import { COST_CATEGORIES } from '../../routes/accounting/accounting-core';

export class DataNodeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;

function toInt(field: string, v: string): number {
  const n = Number(v.replace(/[,，円\s]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000_000) throw new DataNodeError('FLOW_DATA_INVALID', `"${field}" は 0 以上の整数にしてください`);
  return n;
}

/** where の値（展開後の文字）を列の型に直す */
function whereOf(resource: FlowDataResource, where: { field: string; value: string }[]): Record<string, unknown> {
  const spec = FLOW_DATA_RESOURCES[resource];
  const out: Record<string, unknown> = {};
  for (const w of where) {
    if (!spec.filterable.includes(w.field)) throw new DataNodeError('FLOW_DATA_INVALID', `"${w.field}" では絞り込めません`);
    const type = spec.fields[w.field];
    out[w.field] = type === 'boolean' ? w.value === 'true' : type === 'number' ? Number(w.value) : w.value;
  }
  return out;
}

function pick(row: Record<string, unknown>, resource: FlowDataResource): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(FLOW_DATA_RESOURCES[resource].fields)) {
    const v = row[key];
    out[key] = v instanceof Date ? v.toISOString() : v ?? null;
  }
  return out;
}

const SELECT: Record<Exclude<FlowDataResource, 'deliverable' | 'cost_entry'>, Record<string, true>> = {
  deal: { id: true, title: true, company: true, amount: true, stage: true },
  project: { id: true, code: true, name: true, client: true, contractAmount: true, status: true },
  vendor: { id: true, name: true, kind: true, invoiceRegistered: true },
};

export interface DataRequest {
  resource: FlowDataResource;
  op: FlowDataOp;
  where: { field: string; value: string }[];
  values: Record<string, string>;
  limit: number;
  actorId: string | null;
}

/** 1 回分を実行する。戻り値はそのノードの出力（list: rows・count、それ以外: 列） */
export async function runDataRequest(db: TenantDb, req: DataRequest): Promise<Record<string, unknown>> {
  const spec = FLOW_DATA_RESOURCES[req.resource];
  if (!spec || !spec.ops.includes(req.op)) throw new DataNodeError('FLOW_DATA_INVALID', 'この資源ではその操作はできません');
  for (const k of Object.keys(req.values)) {
    if (!spec.writable.includes(k)) throw new DataNodeError('FLOW_DATA_INVALID', `"${k}" は書けません`);
  }
  const where = whereOf(req.resource, req.where);

  if (req.op === 'list' || req.op === 'get') {
    const take = req.op === 'list' ? req.limit : 1;
    let rows: Record<string, unknown>[];
    if (req.resource === 'deliverable') {
      rows = (await db.task.findMany({
        where: { ...where, status: 'DONE' },
        select: { id: true, title: true, department: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take,
      })) as Record<string, unknown>[];
    } else if (req.resource === 'cost_entry') {
      throw new DataNodeError('FLOW_DATA_INVALID', '原価は作成だけです');
    } else {
      const delegate = db[req.resource] as unknown as { findMany(a: unknown): Promise<Record<string, unknown>[]> };
      rows = await delegate.findMany({ where, select: SELECT[req.resource], orderBy: { createdAt: 'desc' }, take });
    }
    const picked = rows.map((r) => pick(r, req.resource));
    if (req.op === 'list') return { rows: picked, count: picked.length };
    if (picked.length === 0) throw new DataNodeError('FLOW_DATA_NOT_FOUND', '該当するデータがありません');
    return picked[0];
  }

  const v = req.values;
  if (req.resource === 'deal') {
    const data: Record<string, unknown> = {};
    if (v.title !== undefined) data.title = v.title.trim().slice(0, 200);
    if (v.company !== undefined) data.company = v.company.trim().slice(0, 200) || null;
    if (v.amount !== undefined && v.amount.trim() !== '') data.amount = toInt('amount', v.amount);
    if (v.stage !== undefined && v.stage.trim() !== '') {
      if (!(PIPELINE_STAGES as readonly string[]).includes(v.stage)) throw new DataNodeError('FLOW_DATA_INVALID', 'ステージの値が違います');
      data.stage = v.stage;
    }
    if (req.op === 'create') {
      if (typeof data.title !== 'string' || data.title === '') throw new DataNodeError('FLOW_DATA_INVALID', '"title" は必須です');
      const row = (await db.deal.create({ data: data as never, select: SELECT.deal })) as Record<string, unknown>;
      return pick(row, 'deal');
    }
    const id = typeof where.id === 'string' ? where.id : '';
    const found = await db.deal.findFirst({ where: { id }, select: { id: true } });
    if (!found) throw new DataNodeError('FLOW_DATA_NOT_FOUND', '該当するデータがありません');
    const row = (await db.deal.update({ where: { id }, data: data as never, select: SELECT.deal })) as Record<string, unknown>;
    return pick(row, 'deal');
  }

  if (req.resource === 'cost_entry' && req.op === 'create') {
    const projectId = (v.projectId ?? '').trim();
    const vendorId = (v.vendorId ?? '').trim() || null;
    if (!projectId || !(await assertSameOrg(db, 'project', projectId))) throw new DataNodeError('FLOW_DATA_NOT_FOUND', '工事が見つかりません');
    if (vendorId && !(await assertSameOrg(db, 'vendor', vendorId))) throw new DataNodeError('FLOW_DATA_NOT_FOUND', '取引先が見つかりません');
    const category = (v.category ?? '').trim();
    if (!(COST_CATEGORIES as readonly string[]).includes(category)) throw new DataNodeError('FLOW_DATA_INVALID', '分類は MATERIAL / LABOR / SUBCON / OTHER です');
    const incurredOn = (v.incurredOn ?? '').trim();
    if (!DATE_RE.test(incurredOn) || Number.isNaN(new Date(`${incurredOn}T00:00:00Z`).getTime())) {
      throw new DataNodeError('FLOW_DATA_INVALID', '日付は YYYY-MM-DD です');
    }
    const row = (await db.costEntry.create({
      data: {
        projectId,
        vendorId,
        category,
        amount: toInt('amount', v.amount ?? ''),
        taxAmount: v.taxAmount !== undefined && v.taxAmount.trim() !== '' ? toInt('taxAmount', v.taxAmount) : 0,
        incurredOn: new Date(`${incurredOn}T00:00:00Z`),
        description: v.description ? v.description.slice(0, MAX_TEXT) : null,
        // AI が読んだ数字は下書き。ここは定義の値に関係なく固定（T14）
        status: 'DRAFT',
        source: 'CHAT',
        createdBy: req.actorId,
      } as never,
    })) as Record<string, unknown>;
    return pick(row, 'cost_entry');
  }
  throw new DataNodeError('FLOW_DATA_INVALID', 'この資源ではその操作はできません');
}
