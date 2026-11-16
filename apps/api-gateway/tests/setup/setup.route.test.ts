import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setTenant } from '../helpers/tenant';

const prismaMock = { organization: { findUnique: vi.fn() }, aILog: { count: vi.fn() } };
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

let currentUser: Record<string, unknown> = { orgId: 'org-1', sub: 'owner-1', role: 'OWNER' };
vi.mock('../../src/middleware/auth', () => ({
  requireUser: async () => {},
  userOf: () => ({ sub: currentUser.sub, orgId: currentUser.orgId }),
  requireAuth: async (req: { user?: unknown }) => {
    await setTenant(req as never, currentUser as never);
  },
  requireOwner: async (req: { user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    await setTenant(req as never, currentUser as never);
    if (currentUser.role !== 'OWNER') {
      reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'この操作はオーナーのみ行えます' } });
    }
  },
}));

const collectSetupStatus = vi.fn();
vi.mock('../../src/services/setup-status', () => ({ collectSetupStatus: () => collectSetupStatus() }));

const { organizationRoutes } = await import('../../src/routes/organizations');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(organizationRoutes, { prefix: '/api/organizations' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { orgId: 'org-1', sub: 'owner-1', role: 'OWNER' };
  collectSetupStatus.mockResolvedValue([{ key: 'storage', label: 'ファイルの保存先', health: 'ok', detail: '', action: '' }]);
});

describe('GET /api/organizations/me/setup', () => {
  it('オーナーには設定の状態を返す', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/organizations/me/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].key).toBe('storage');
    await app.close();
  });

  it('⚠️ オーナー以外には見せない（設定の穴は攻撃側に有用な情報）', async () => {
    currentUser = { orgId: 'org-1', sub: 'member-1', role: 'MEMBER' };
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/organizations/me/setup' });
    expect(res.statusCode).toBe(403);
    expect(collectSetupStatus).not.toHaveBeenCalled();
    await app.close();
  });
});
