import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { setTenant } from '../helpers/tenant';

const prismaMock = {
  user: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  invitation: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  // 所属・役割・状態の正本（docs/design/multi-tenancy.md ADR-2）
  membership: { findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

let currentUser: Record<string, unknown> = { orgId: 'org-1', sub: 'owner-1', role: 'OWNER' };
vi.mock('../../src/middleware/auth', () => ({
  requireUser: async () => {},
  userOf: () => ({ sub: currentUser.sub, orgId: currentUser.orgId }),
  requireAuth: async (req: { user?: unknown }) => {
    await setTenant(req as never, currentUser as never);
  },
  requireOwner: async (req: { user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void }; sent?: boolean }) => {
    await setTenant(req as never, currentUser as never);
    if (currentUser.role !== 'OWNER') {
      reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'オーナーのみ' } });
    }
  },
  requireAdmin: async (req: { user?: unknown }) => {
    await setTenant(req as never, currentUser as never);
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

  it('既にこの組織のメンバーのメールには発行しない', async () => {
    prismaMock.membership.findFirst.mockResolvedValue({ id: 'm-existing' });
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations', payload: { email: 'dup@example.com' },
    });
    expect(res.statusCode).toBe(409);
    // 「この組織の」所属だけを見る（テナントクライアントが orgId を付ける）
    expect(prismaMock.membership.findFirst.mock.calls[0][0].where).toEqual({ user: { email: 'dup@example.com' }, orgId: 'org-1' });
    expect(prismaMock.invitation.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('別の組織で登録済みの人は招待できる（UC2: 既存ユーザーの招待）', async () => {
    prismaMock.membership.findFirst.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-elsewhere' });
    prismaMock.invitation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'inv-2', email: data.email, role: data.role, expiresAt: data.expiresAt, createdAt: new Date(),
    }));
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations', payload: { email: 'tax@example.com' },
    });
    expect(res.statusCode).toBe(201);
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
      membership: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
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
    // 所属の正本（Membership）も招待の org / role で作る
    const membership = tx.membership.create.mock.calls[0][0].data;
    expect(membership.orgId).toBe('org-1');
    expect(membership.role).toBe('MEMBER');
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
    prismaMock.membership.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.user.updateMany.mockResolvedValue({ count: 1 });
    const app = await build();
    await app.inject({ method: 'PATCH', url: '/api/members/u-2/role', payload: { role: 'ADMIN' } });
    // 正本は Membership（その組織の行だけ）
    expect(prismaMock.membership.updateMany.mock.calls[0][0].where).toEqual({ userId: 'u-2', orgId: 'org-1' });
    // 移行期間中の写し（User.role）も、User.orgId が同じ組織のときだけ
    expect(prismaMock.user.updateMany.mock.calls[0][0].where).toEqual({ id: 'u-2', orgId: 'org-1' });
    await app.close();
  });

  it('⚠️ 自分自身の役割は変えられない（オーナー0人の組織を作らない）', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/owner-1/role', payload: { role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.membership.updateMany).not.toHaveBeenCalled();
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
    prismaMock.membership.updateMany.mockResolvedValue({ count: 1 });
    const app = await build();
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/u-2/status', payload: { status: 'DISABLED' },
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.membership.updateMany.mock.calls[0][0].data).toEqual({ status: 'DISABLED' });
  });

  it('⚠️ 無効化はこの組織の所属だけ（アカウント全体＝他の組織には影響しない。ADR-2）', async () => {
    prismaMock.membership.updateMany.mockResolvedValue({ count: 1 });
    const app = await build();
    await app.inject({ method: 'PATCH', url: '/api/members/u-2/status', payload: { status: 'DISABLED' } });
    expect(prismaMock.membership.updateMany.mock.calls[0][0].where).toEqual({ userId: 'u-2', orgId: 'org-1' });
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('他組織のメンバーは 404', async () => {
    prismaMock.membership.updateMany.mockResolvedValue({ count: 0 });
    const app = await build();
    const res = await app.inject({ method: 'PATCH', url: '/api/members/u-B/status', payload: { status: 'DISABLED' } });
    expect(res.statusCode).toBe(404);
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

describe('GET /api/members', () => {
  it('role / status は この組織の Membership のもの（User.role ではない）', async () => {
    prismaMock.membership.findMany.mockResolvedValue([
      { role: 'MEMBER', status: 'DISABLED', createdAt: new Date(), user: { id: 'u-2', name: 'T', email: 't@example.com' } },
    ]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/members' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0]).toMatchObject({ id: 'u-2', role: 'MEMBER', status: 'DISABLED' });
    expect(prismaMock.membership.findMany.mock.calls[0][0].where).toEqual({ orgId: 'org-1' });
    await app.close();
  });
});

describe('既存ユーザーの招待受諾（UC2 / 設計書 §10.3）', () => {
  const invitation = {
    id: 'inv-1', orgId: 'org-1', email: 'tax@example.com', role: 'MEMBER', createdBy: 'owner-1',
    expiresAt: future, acceptedAt: null, revokedAt: null,
  };

  it('プレビューは requiresLogin を返す（メールアドレス自体は返さない。Q2）', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue({ ...invitation, org: { name: '株式会社テスト' } });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-t' });
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/members/invitations/preview/tok' });
    expect(res.json().data.requiresLogin).toBe(true);
    expect(res.body).not.toContain('tax@example.com');
    await app.close();
  });

  it('新規登録の受諾で既存のメールなら 409 ACCOUNT_EXISTS（アカウントを二重に作らない）', async () => {
    prismaMock.invitation.findUnique.mockResolvedValue(invitation);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-t' });
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept',
      payload: { token: TOKEN, name: 'x', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_EXISTS');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('ログイン中の本人のメールと一致すれば、招待の org / role で所属を作り、その組織のトークンを返す', async () => {
    currentUser = { orgId: 'org-OTHER', sub: 'u-t', role: 'OWNER' };
    prismaMock.invitation.findUnique.mockResolvedValue(invitation);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-t', name: 'T', email: 'Tax@Example.com' });
    prismaMock.membership.findUnique.mockResolvedValue(null);
    const tx = {
      invitation: { updateMany: vi.fn(async () => ({ count: 1 })) },
      membership: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
    };
    prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    prismaMock.membership.findMany.mockResolvedValue([]);
    (prismaMock.user as Record<string, unknown>).update = vi.fn(async () => ({}));

    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept-existing',
      // body で別の組織・役割を要求しても無視される
      payload: { token: TOKEN, orgId: 'org-EVIL', role: 'OWNER' },
    });
    expect(res.statusCode).toBe(201);
    expect(tx.membership.create.mock.calls[0][0].data).toEqual({
      userId: 'u-t', orgId: 'org-1', role: 'MEMBER', invitedBy: 'owner-1',
    });
    await app.close();
  });

  it('⚠️ 招待のメールと違うアカウントでは参加できない（リンクを拾った別人を通さない）', async () => {
    currentUser = { orgId: 'org-OTHER', sub: 'u-x', role: 'OWNER' };
    prismaMock.invitation.findUnique.mockResolvedValue(invitation);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-x', name: 'X', email: 'someone@example.com' });
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept-existing', payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INVITATION_EMAIL_MISMATCH');
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('既に所属している（無効化されている場合も）なら 409 で、所属を作り直さない', async () => {
    currentUser = { orgId: 'org-OTHER', sub: 'u-t', role: 'OWNER' };
    prismaMock.invitation.findUnique.mockResolvedValue(invitation);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-t', name: 'T', email: 'tax@example.com' });
    prismaMock.membership.findUnique.mockResolvedValue({ status: 'DISABLED' });
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept-existing', payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(409);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('同じリンクの2回目は 409（条件付き更新で1回だけ勝つ）', async () => {
    currentUser = { orgId: 'org-OTHER', sub: 'u-t', role: 'OWNER' };
    prismaMock.invitation.findUnique.mockResolvedValue(invitation);
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-t', name: 'T', email: 'tax@example.com' });
    prismaMock.membership.findUnique.mockResolvedValue(null);
    const tx = { invitation: { updateMany: vi.fn(async () => ({ count: 0 })) }, membership: { create: vi.fn() } };
    prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/members/invitations/accept-existing', payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(409);
    expect(tx.membership.create).not.toHaveBeenCalled();
    await app.close();
  });
});
