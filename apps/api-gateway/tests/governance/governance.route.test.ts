import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const prismaMock = {
  aILog: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), aggregate: vi.fn() },
  riskEvent: { findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireOwner: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
}));

const { governanceRoutes } = await import('../../src/routes/governance');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(governanceRoutes, { prefix: '/api/governance' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.aILog.findMany.mockResolvedValue([]);
  prismaMock.aILog.count.mockResolvedValue(0);
  prismaMock.riskEvent.findMany.mockResolvedValue([]);
  prismaMock.riskEvent.count.mockResolvedValue(0);
});

describe('PATCH /api/governance/risks/:id/resolve', () => {
  it('自組織のリスクは既読にできる', async () => {
    prismaMock.riskEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.riskEvent.findFirst.mockResolvedValue({ id: 'r-1', orgId: 'org-1', resolved: true });

    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/api/governance/risks/r-1/resolve' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.resolved).toBe(true);
    await app.close();
  });

  it('⚠️ 他組織のリスクは既読にできない（テナント分離）', async () => {
    // ガバナンスは「見張る」機能なので、ここで分離が破れているのは売り文句と正面衝突する。
    // 以前は prisma.riskEvent.update({ where: { id } }) で orgId を見ておらず、
    // id さえ知っていれば他組織のリスクを既読にできた。
    prismaMock.riskEvent.updateMany.mockResolvedValue({ count: 0 });

    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/api/governance/risks/r-other/resolve' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('必ず orgId を where に含めて更新する', async () => {
    prismaMock.riskEvent.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.riskEvent.findFirst.mockResolvedValue({ id: 'r-1' });

    const app = await build();
    await app.inject({ method: 'PATCH', url: '/api/governance/risks/r-1/resolve' });

    const where = prismaMock.riskEvent.updateMany.mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1');
    expect(where.id).toBe('r-1');
    await app.close();
  });

  it('存在しないものと他組織のものを区別させない（どちらも 404）', async () => {
    // 404 の文言で「あるが他人のもの」と分かると、id の存在を探れてしまう
    prismaMock.riskEvent.updateMany.mockResolvedValue({ count: 0 });
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/api/governance/risks/does-not-exist/resolve' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).not.toContain('組織');
    await app.close();
  });
});

describe('GET /api/governance/risks', () => {
  it('一覧も orgId で絞る', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/governance/risks' });
    expect(prismaMock.riskEvent.findMany.mock.calls[0][0].where.orgId).toBe('org-1');
    await app.close();
  });
});
