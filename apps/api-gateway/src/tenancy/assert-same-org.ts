// 別の行を指す参照が同じ組織のものかを確かめる（不変条件 I3、ADR-6）。
// テナントクライアントで引くので、別組織の id なら見つからない（= false）。

import type { TenantDb, TenantTx } from './tenant-db';

type RefModel = 'agent' | 'project' | 'vendor' | 'channelConnection' | 'capability' | 'task' | 'uploadedFile' | 'chatSession';

export async function assertSameOrg(db: TenantDb | TenantTx, model: RefModel, id: string | null | undefined): Promise<boolean> {
  if (!id) return true;
  const delegate = db[model] as unknown as { findFirst(a: unknown): Promise<unknown> };
  const row = await delegate.findFirst({ where: { id }, select: { id: true } });
  return row !== null && row !== undefined;
}
