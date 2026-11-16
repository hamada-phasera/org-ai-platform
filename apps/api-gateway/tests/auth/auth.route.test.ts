import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import * as bcrypt from 'bcryptjs';

// 認証まわりの挙動バグ（設計書 docs/design/multi-tenancy.md §2.4 E3 / E4）の回帰テスト。
// middleware は本物を使い、prisma だけをモックする（JWT の role を信じないことを確かめるため）。

const prismaMock = {
  user: { findUnique: vi.fn(), create: vi.fn() },
  organization: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

const { authRoutes } = await import('../../src/routes/auth');
const { organizationRoutes } = await import('../../src/routes/organizations');

const SECRET = 'x'.repeat(32);
const PASSWORD_HASH = bcrypt.hashSync('correct-password', 4);

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(jwt, { secret: SECRET });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(organizationRoutes, { prefix: '/api/organizations' });
  await app.ready();
  return app;
}

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u-1', email: 'a@example.com', name: 'A', passwordHash: PASSWORD_HASH,
    role: 'OWNER', status: 'ACTIVE', orgId: 'org-1', createdAt: new Date(), ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.organization.findUnique.mockResolvedValue({ subscriptionStatus: null });
});

describe('POST /api/auth/login', () => {
  it('有効なアカウントはログインできる', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow());
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'correct-password' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.token).toBeTruthy();
    await app.close();
  });

  it('⚠️ 無効化したアカウントはログインできない（E3）', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow({ status: 'DISABLED' }));
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'correct-password' },
    });
    expect(res.statusCode).toBe(401);
    // 文言は資格情報の誤りと同じ（止められていることを漏らさない）
    expect(res.json().error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(res.json().data).toBeUndefined();
    await app.close();
  });

  it('パスワード違いは 401', async () => {
    prismaMock.user.findUnique.mockResolvedValue(userRow());
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('PATCH /api/organizations/me', () => {
  it('⚠️ JWT の role が OWNER でも、DB で降格済みなら 403（E4）', async () => {
    const app = await build();
    const token = app.jwt.sign({ sub: 'u-1', orgId: 'org-1', role: 'OWNER', email: 'a@example.com' });
    prismaMock.user.findUnique.mockResolvedValue(userRow({ role: 'MEMBER' }));
    const res = await app.inject({
      method: 'PATCH', url: '/api/organizations/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '乗っ取り' },
    });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.organization.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('DB 上の OWNER は更新できる', async () => {
    const app = await build();
    const token = app.jwt.sign({ sub: 'u-1', orgId: 'org-1', role: 'MEMBER', email: 'a@example.com' });
    prismaMock.user.findUnique.mockResolvedValue(userRow({ role: 'OWNER' }));
    prismaMock.organization.update.mockResolvedValue({ id: 'org-1', name: '新しい名前' });
    const res = await app.inject({
      method: 'PATCH', url: '/api/organizations/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '新しい名前' },
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.organization.update.mock.calls[0][0].where.id).toBe('org-1');
    await app.close();
  });
});
