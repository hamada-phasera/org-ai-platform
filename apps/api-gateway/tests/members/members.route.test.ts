import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'crypto';

const prismaMock = {
  user: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  invitation: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

let currentUser: Record<string, unknown> = { orgId: 'org-1', sub: 'owner-1', role: 'OWNER' };
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = currentUser;
  },
  requireOwner: async (req: { user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void }; sent?: boolean }) => {
    req.user = currentUser;
    if (currentUser.role !== 'OWNER') {
      reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'オーナーのみ' } });
    }
  },
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = currentUser;
  },
}));

vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'hashed') } }));

const { memberRoutes } = await import('../../src/routes/members');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('jwt', { sign: () => 'signed-jwt' } as never);
  await app.register(memberRoutes, { prefix: '/api/members' });
  await app.ready();
  return app;
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
/** accept は zod で min(20) を要求するので、テストでも実物同等の長さを使う */
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 1000);

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { orgId: 'org-1', sub: 'owner-1', role: 'OWNER' };
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.invitation.findMany.mockResolvedValue([]);
});

describe('POST /api/members/invitations', () => {
  it('生トークンは発行時の応答にだけ現れ、DB にはハッシュしか保存しない', async () => {
    prismaMock.invitation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'inv-1', email: data.email, role: data.role, expiresAt: data.expiresAt, createdAt: new Date(),
    }));

    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations',
      payload: { email: 'new@example.com', role: 'MEMBER' },
    });

    expect(res.statusCode).toBe(201);
    const token = res.json().data.token;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    // ⚠️ DB に入るのはハッシュだけ。生値が保存されていたら、DB を読まれた時点で招待が成立する
    const saved = prismaMock.invitation.create.mock.calls[0][0].data;
    expect(saved.tokenHash).toBe(hash(token));
    expect(JSON.stringify(saved)).not.toContain(token);
    await app.close();
  });

  it('OWNER 以外は発行できない', async () => {
    currentUser = { orgId: 'org-1', sub: 'admin-1', role: 'ADMIN' };
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations', payload: { role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.invitation.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('⚠️ OWNER を招待で渡せない（オーナーが増殖しない）', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations',
      payload: { email: 'x@example.com', role: 'OWNER' },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.invitation.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('既に登録済みのメールには発行しない', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-existing' });
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations', payload: { email: 'dup@example.com' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe('GET /api/members/invitations/preview/:token', () => {
  it('組織名と役割だけを返す（メールや発行者は返さない）', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({
      role: 'MEMBER', expiresAt: future, acceptedAt: null, revokedAt: null,
      org: { name: '株式会社テスト' },
    });
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/members/invitations/preview/tok' });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.organizationName).toBe('株式会社テスト');
    // ⚠️ リンクを拾った第三者に組織の内情を渡さない
    expect(JSON.stringify(body)).not.toContain('createdBy');
    expect(JSON.stringify(body)).not.toContain('@');
    await app.close();
  });

  it.each([
    ['期限切れ', { role: 'MEMBER', expiresAt: past, acceptedAt: null, revokedAt: null, org: { name: 'X' } }],
    ['使用済み', { role: 'MEMBER', expiresAt: future, acceptedAt: new Date(), revokedAt: null, org: { name: 'X' } }],
    ['取消済み', { role: 'MEMBER', expiresAt: future, acceptedAt: null, revokedAt: new Date(), org: { name: 'X' } }],
    ['存在しない', null],
  ])('%s は同じ 404 にする（理由を細かく返さない）', async (_name, row) => {
    prismaMock.invitation.findUnique.mockResolvedValue(row);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/members/invitations/preview/tok' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /api/members/invitations/accept', () => {
  const invitation = {
    id: 'inv-1', orgId: 'org-1', email: 'new@example.com', role: 'MEMBER',
    expiresAt: future, acceptedAt: null, revokedAt: null,
  };

  it('⚠️ orgId と role は招待から取る（ボディの値を信用しない）', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invitation);
    prismaMock.user.findUnique.mockResolvedValue(null);
    const tx = {
      invitation: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => ({})) },
      user: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'u-new', ...data })) },
    };
    prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));

    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept',
      // 悪意のあるボディ: 別組織・最強権限を要求する
      payload: { token: TOKEN, name: '新入り', password: 'password123', orgId: 'org-EVIL', role: 'OWNER' },
    });

    expect(res.statusCode).toBe(201);
    const created = tx.user.create.mock.calls[0][0].data;
    expect(created.orgId).toBe('org-1');   // 招待の org
    expect(created.role).toBe('MEMBER');   // 招待の role
    await app.close();
  });

  it('同じリンクを2回踏んでも2人できない（条件付き更新で1回だけ勝つ）', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invitation);
    const tx = {
      invitation: { updateMany: vi.fn(async () => ({ count: 0 })), update: vi.fn() }, // 既に消費済み
      user: { create: vi.fn() },
    };
    prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));

    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept',
      payload: { token: TOKEN, name: '二人目', password: 'password123' },
    });

    expect(res.statusCode).toBe(409);
    expect(tx.user.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('期限切れの招待では作らない', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({ ...invitation, expiresAt: past });
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept',
      payload: { token: TOKEN, name: 'x', password: 'password123' },
    });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('短いパスワードは弾く', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept',
      payload: { token: TOKEN, name: 'x', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('PATCH /api/members/:userId/role', () => {
  it('必ず orgId で絞る（他組織のメンバーを昇格させない）', async () => {
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
    const app = await build();
    await app.inject({ method: 'PATCH', url: '/api/members/u-2/role', payload: { role: 'ADMIN' } });
    expect(prismaMock.user.updateMany.mock.calls[0][0].where.orgId).toBe('org-1');
    await app.close();
  });

  it('⚠️ 自分自身の役割は変えられない（オーナー0人の組織を作らない）', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/owner-1/role', payload: { role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('OWNER への昇格はできない', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/u-2/role', payload: { role: 'OWNER' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('PATCH /api/members/:userId/status', () => {
  it('無効化は物理削除ではない（作成者参照を壊さない）', async () => {
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
    const app = await build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/u-2/status', payload: { status: 'DISABLED' },
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.user.updateMany.mock.calls[0][0].data).toEqual({ status: 'DISABLED' });
    await app.close();
  });

  it('自分自身は無効化できない', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/owner-1/status', payload: { status: 'DISABLED' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
