import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import * as bcrypt from 'bcryptjs';

// 認証まわりの挙動バグ（設計書 docs/design/multi-tenancy.md §2.4 E3 / E4）の回帰テスト。
// middleware は本物を使い、prisma だけをモックする（JWT の role を信じないことを確かめるため）。

import { userWithMembership } from '../helpers/membership';

const prismaMock = {
  user: { findUnique: vi.fn(), create: vi.fn() },
  organization: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  membership: { findMany: vi.fn(), create: vi.fn() },
  capability: { create: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: `cap-${String(a.data.name)}` })) },
  requiredCredential: { create: vi.fn() },
  auditEvent: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
  $transaction: vi.fn(),
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');

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
  clearMembershipCache();
  prismaMock.membership.findMany.mockResolvedValue([
    { orgId: 'org-1', role: 'OWNER', org: { name: 'A社', plan: 'STARTER' } },
  ]);
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

describe('POST /api/auth/register', () => {
  it('組織・本人・オーナーの Membership を1トランザクションで作る', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(prismaMock));
    prismaMock.organization.create.mockResolvedValue({ id: 'org-new', name: '新会社', plan: 'STARTER' });
    prismaMock.user.create.mockResolvedValue({ id: 'u-new', name: 'N', email: 'n@example.com', role: 'OWNER' });
    prismaMock.membership.create.mockResolvedValue({});
    prismaMock.organization.update.mockResolvedValue({});
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'N', email: 'n@example.com', password: 'password123', orgName: '新会社' },
    });
    expect(res.statusCode).toBe(201);
    expect(prismaMock.membership.create.mock.calls[0][0].data).toEqual({ userId: 'u-new', orgId: 'org-new', role: 'OWNER' });
    // 作成者を記録する（トライアルを作成者ごとに1回にする判定に使う）
    expect(prismaMock.organization.update.mock.calls[0][0].data).toEqual({ createdBy: 'u-new' });
    // 既定のノードが新しい組織に入る（E8）
    expect(prismaMock.capability.create).toHaveBeenCalled();
    for (const [args] of prismaMock.capability.create.mock.calls) expect(args.data.orgId).toBe('org-new');
    const payload = app.jwt.decode<{ orgId: string }>(res.json().data.token)!;
    expect(payload.orgId).toBe('org-new');
    // 組織の作成は監査に残る（同じトランザクション・新しい組織に）
    expect(prismaMock.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.auditEvent.create.mock.calls[0][0]).toMatchObject({
      data: { orgId: 'org-new', actorId: 'u-new', action: 'org.create', targetId: 'org-new' },
    });
    await app.close();
  });

  it('D1: 登録と同時にカード不要のトライアルを始める（trialEndsAt = 作成時刻 + 30 日、プランは梅）', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(prismaMock));
    prismaMock.organization.create.mockResolvedValue({ id: 'org-new', name: '新会社', plan: 'STARTER' });
    prismaMock.user.create.mockResolvedValue({ id: 'u-new', name: 'N', email: 'n@example.com', role: 'OWNER' });
    prismaMock.membership.create.mockResolvedValue({});
    prismaMock.organization.update.mockResolvedValue({});
    const app = await build();
    const before = Date.now();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'N', email: 'n@example.com', password: 'password123', orgName: '新会社' },
    });
    expect(res.statusCode).toBe(201);
    const data = prismaMock.organization.create.mock.calls[0][0].data as { plan: string; trialEndsAt: Date };
    expect(data.plan).toBe('STARTER');
    const DAY = 86_400_000;
    expect(data.trialEndsAt.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(data.trialEndsAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    await app.close();
  });

  it('BILLING_TRIAL_DAYS で日数を変えられる', async () => {
    const original = process.env.BILLING_TRIAL_DAYS;
    process.env.BILLING_TRIAL_DAYS = '14';
    try {
      prismaMock.user.findUnique.mockResolvedValue(null);
      prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(prismaMock));
      prismaMock.organization.create.mockResolvedValue({ id: 'org-new', name: '新会社', plan: 'STARTER' });
      prismaMock.user.create.mockResolvedValue({ id: 'u-new', name: 'N', email: 'n@example.com', role: 'OWNER' });
      const app = await build();
      const res = await app.inject({
        method: 'POST', url: '/api/auth/register',
        payload: { name: 'N', email: 'n@example.com', password: 'password123', orgName: '新会社' },
      });
      expect(res.statusCode).toBe(201);
      const ends = (prismaMock.organization.create.mock.calls[0][0].data as { trialEndsAt: Date }).trialEndsAt;
      expect(Math.round((ends.getTime() - Date.now()) / 86_400_000)).toBe(14);
      await app.close();
    } finally {
      if (original === undefined) delete process.env.BILLING_TRIAL_DAYS;
      else process.env.BILLING_TRIAL_DAYS = original;
    }
  });
});

describe('PATCH /api/organizations/me', () => {
  it('⚠️ JWT の role が OWNER でも、DB で降格済みなら 403（E4）', async () => {
    const app = await build();
    const token = app.jwt.sign({ sub: 'u-1', orgId: 'org-1', role: 'OWNER', email: 'a@example.com' });
    // 所属の確認（Membership）では MEMBER に降格済み
    prismaMock.user.findUnique.mockResolvedValue(userWithMembership({ role: 'MEMBER' }));
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
    prismaMock.user.findUnique.mockResolvedValue(userWithMembership({ role: 'OWNER' }));
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

// チャンク 7: メールは前後の空白を除いて小文字にしてから扱う
describe('メールの正規化', () => {
  function stubRegister() {
    prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(prismaMock));
    prismaMock.organization.create.mockResolvedValue({ id: 'org-new', name: '新会社', plan: 'STARTER' });
    prismaMock.user.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({ id: 'u-new', ...a.data }));
    prismaMock.membership.create.mockResolvedValue({});
    prismaMock.organization.update.mockResolvedValue({});
  }

  it('A@X.jp で登録すると a@x.jp で保存し、重複確認も小文字で引く', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    stubRegister();
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { name: 'N', email: '  A@X.jp ', password: 'password123', orgName: '新会社' },
    });
    expect(res.statusCode).toBe(201);
    expect(prismaMock.user.findUnique.mock.calls[0][0]).toEqual({ where: { email: 'a@x.jp' } });
    expect(prismaMock.user.create.mock.calls[0][0].data.email).toBe('a@x.jp');
    expect(res.json().data.user.email).toBe('a@x.jp');
    await app.close();
  });

  it('A@X.jp で登録した後、a@x.jp（と大文字混じり）でログインできる', async () => {
    // DB には登録時に小文字で入っている
    prismaMock.user.findUnique.mockImplementation(async (a: { where: { email?: string } }) =>
      a.where.email === 'a@x.jp' ? userRow({ email: 'a@x.jp' }) : null);
    const app = await build();
    for (const email of ['a@x.jp', 'A@X.jp', ' a@X.JP ']) {
      const res = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { email, password: 'correct-password' },
      });
      expect(res.statusCode, email).toBe(200);
    }
    await app.close();
  });

  it('同じメールの再登録は大文字小文字が違っても 409', async () => {
    prismaMock.user.findUnique.mockImplementation(async (a: { where: { email?: string } }) =>
      a.where.email === 'a@x.jp' ? userRow({ email: 'a@x.jp' }) : null);
    stubRegister();
    const app = await build();
    for (const email of ['a@x.jp', 'A@x.JP']) {
      const res = await app.inject({
        method: 'POST', url: '/api/auth/register',
        payload: { name: 'N', email, password: 'password123', orgName: '新会社' },
      });
      expect(res.statusCode, email).toBe(409);
      expect(res.json().error.code).toBe('AUTH_EMAIL_EXISTS');
    }
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    await app.close();
  });
});
