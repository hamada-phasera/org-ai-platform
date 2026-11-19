// 業務フローの結果ページの読み出しと、フローの保存に合わせた写し直し（docs/design/canvas-home.md §3.5）。
// store.ts（writeFlow のトランザクション）と result-page.ts の両方が使う。store.ts を import しない（循環させない）。

import { alignFlowPageDefinition, pageDefinitionSchema, type FlowDefinition } from '@org-ai/shared-types';
import type { Prisma } from '@prisma/client';
import type { TenantTx } from '../../tenancy/tenant-db';
import { canonicalHashOf } from '../pages/upsert';

const json = (v: unknown) => v as Prisma.InputJsonValue;

export const FLOW_PAGE_SELECT = {
  id: true,
  slug: true,
  title: true,
  status: true,
  minRole: true,
  version: true,
  definition: true,
  definitionHash: true,
  flowId: true,
} as const;

export interface FlowPageRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  minRole: string;
  version: number;
  definition: unknown;
  definitionHash: string;
  flowId: string | null;
}

export async function loadFlowPage(db: Pick<TenantTx, 'customPage'>, flowId: string): Promise<FlowPageRow | null> {
  return (await db.customPage.findFirst({ where: { flowId, source: 'FLOW' }, select: FLOW_PAGE_SELECT })) as FlowPageRow | null;
}

const ROLE_ORDER: Record<string, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

/**
 * フローの保存に合わせて結果ページを写し直す（writeFlow のトランザクションの中）。
 * - 定義が変わった: フォームの項目をきっかけに合わせる（データのキーが消えても行は消さない。ブロックが「合いません」と出る）
 * - 役割が上がった: ページの役割もフローより下にしない（見えないフローのページを一覧に出さない）
 */
export async function syncFlowPage(
  tx: Pick<TenantTx, 'customPage'>,
  flowId: string,
  change: { definition?: FlowDefinition; minRole?: string },
): Promise<void> {
  const page = await loadFlowPage(tx, flowId);
  if (!page) return;
  const data: Record<string, unknown> = {};
  if (change.definition) {
    const current = pageDefinitionSchema.safeParse(page.definition);
    if (current.success) {
      const aligned = alignFlowPageDefinition(current.data, change.definition);
      const hash = canonicalHashOf(aligned);
      if (hash !== page.definitionHash && pageDefinitionSchema.safeParse(aligned).success) {
        Object.assign(data, { definition: json(aligned), definitionHash: hash, version: page.version + 1 });
      }
    }
  }
  if (change.minRole && (ROLE_ORDER[change.minRole] ?? 3) > (ROLE_ORDER[page.minRole] ?? 3)) data.minRole = change.minRole;
  if (Object.keys(data).length > 0) await tx.customPage.updateMany({ where: { id: page.id }, data });
}

