// ルートのテストで middleware/auth をモックするときに、本物の requireAuth と同じく
// request.user と request.tenant（tenantDb 付き）を載せるヘルパ。
// tenantDb は `utils/prisma`（各テストでモック済み）を包むので、モックへの呼び出しには orgId が差し込まれる。

import type { UserRole } from '@org-ai/shared-types';

export interface FakeUser {
  orgId: string;
  sub?: string;
  role?: string;
  email?: string;
  [k: string]: unknown;
}

export async function setTenant(req: { user?: unknown; tenant?: unknown }, user: FakeUser): Promise<void> {
  const { makeTenantContext } = await import('../../src/tenancy/context');
  req.user = user;
  req.tenant = makeTenantContext({
    orgId: user.orgId,
    userId: user.sub ?? null,
    role: (user.role as UserRole | undefined) ?? null,
    source: 'http',
  });
}
