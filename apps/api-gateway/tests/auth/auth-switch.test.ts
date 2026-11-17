import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import * as bcrypt from 'bcryptjs';
import { FakePrisma } from '../helpers/fake-prisma';

// 組織の切り替え・ログイン時の組織選択・組織の作成（docs/design/multi-tenancy.md §11.4 S1〜S7）。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

const { authRoutes } = await import('../../src/routes/auth');
const { organizationRoutes } = await import('../../src/routes/organizations');
const { taskRoutes } = await import('../../src/routes/tasks');
const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { MAX_ORGS_CREATED_PER_USER } = await import('../../src/services/organizations');
const { DEFAULT_CAPABILITIES } = await import('../../src/services/default-capabilities');

const SECRET = 'auth-switch-test-secret-at-least-32-chars';
const HASH = bcrypt.hashSync('password123', 4);
const t0 = new Date('2026-01-01T00:00:00Z');

function seed() {
  return {
    organization: [
      { id: 'org-A', name: 'A社', plan: 'STARTER', createdBy: 'u-t', createdAt: t0 },
      { id: 'org-B', name: 'B社', plan: 'PRO', createdBy: 'u-x', createdAt: t0 },
      { id: 'org-C', name: 'C社', plan: 'STARTER', createdBy: 'u-x', createdAt: t0 },
    ],
    user: [
      { id: 'u-t', email: 't@example.com', name: 'T', passwordHash: HASH, status: 'ACTIVE', role: 'OWNER', orgId: 'org-A', createdAt: t0 },
      { id: 'u-d', email: 'd@example.com', name: 'D', passwordHash: HASH, status: 'DISABLED', role: 'OWNER', orgId: 'org-A', createdAt: t0 },
    ],
    membership: [
      { id: 'm1', userId: 'u-t', orgId: 'org-A', role: 'OWNER', status: 'ACTIVE', createdAt: new Date('2026-01-01') },
      { id: 'm2', userId: 'u-t', orgId: 'org-B', role: 'MEMBER', status: 'ACTIVE', createdAt: new Date('2026-02-01') },
      { id: 'm3', userId: 'u-t', orgId: 'org-C', role: 'ADMIN', status: 'DISABLED', createdAt: new Date('2026-03-01') },
      { id: 'm4', userId: 'u-d', orgId: 'org-A', role: 'OWNER', status: 'ACTIVE', createdAt: t0 },
    ],
    task: [
      { id: 'task-A', orgId: 'org-A', title: 'A', status: 'DONE', department: 'GENERAL', input: '', createdAt: t0, updatedAt: t0 },
      { id: 'task-B', orgId: 'org-B', title: 'B', status: 'DONE', department: 'GENERAL', input: '', createdAt: t0, updatedAt: t0 },
    ],
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  fake = new FakePrisma(seed());
  clearMembershipCache();
  if (!app) {
    app = Fastify();
    await app.register(jwt, { secret: SECRET });
    registerTenantContext(app);
    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.register(organizationRoutes, { prefix: '/api/organizations' });
    await app.register(taskRoutes, { prefix: '/api/tasks' });
    await app.ready();
  }
});

const bearer = (orgId: string | null, sub = 'u-t') => ({
  authorization: `Bearer ${app.jwt.sign({ sub, orgId, role: 'OWNER', email: 't@example.com' })}`,
});
const decode = (token: string) => app.jwt.decode<{ orgId: string | null; role: string | null; sub: string }>(token)!;
const user = (id: string) => fake.rows('user').find((u) => u.id === id)!;

describe('POST /api/auth/switch-org', () => {
  it('S1: 所属している組織 B に切り替えると、B 用のトークンと Membership の role が返り、User.orgId が B になる', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: bearer('org-A'), payload: { orgId: 'org-B' } });
    expect(res.statusCode).toBe(200);
    const p = decode(res.json().data.token);
    expect(p.orgId).toBe('org-B');
    expect(p.role).toBe('MEMBER');
    expect(user('u-t').orgId).toBe('org-B');
    // 移行期間中の写し（前のバージョンに戻したときに使われる）
    expect(user('u-t').role).toBe('MEMBER');
    // 新しいトークンで B のデータが見える
    const t = await app.inject({ method: 'GET', url: '/api/tasks/task-B', headers: { authorization: `Bearer ${res.json().data.token}` } });
    expect(t.statusCode).toBe(200);
  });

  it('S2: 所属していない組織には切り替えられない（403 TENANT_NOT_MEMBER、トークンは出ない）', async () => {
    fake.rows('organization').push({ id: 'org-Z', name: 'Z', plan: 'STARTER', createdAt: t0 });
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: bearer('org-A'), payload: { orgId: 'org-Z' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_NOT_MEMBER');
    expect(res.json().data).toBeUndefined();
    expect(user('u-t').orgId).toBe('org-A');
  });

  it('S3: Membership が DISABLED の組織には切り替えられない', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: bearer('org-A'), payload: { orgId: 'org-C' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_NOT_MEMBER');
  });

  it('S4: 存在しない orgId も 403（404 にしない＝存在を漏らさない）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: bearer('org-A'), payload: { orgId: 'org-NOPE' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_NOT_MEMBER');
  });

  it('無効化されたアカウントは切り替えられない（401）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: bearer('org-A', 'u-d'), payload: { orgId: 'org-A' } });
    expect(res.statusCode).toBe(401);
  });

  it('所属組織の無いトークン（orgId=null）からでも切り替えられる', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: bearer(null), payload: { orgId: 'org-A' } });
    expect(res.statusCode).toBe(200);
    expect(decode(res.json().data.token).orgId).toBe('org-A');
  });

  it('S7: 切り替えた後も、古いトークン（A 用）は A の所属が有効な間は A を操作できる（トークンは組織ごとに独立）', async () => {
    const old = bearer('org-A');
    await app.inject({ method: 'POST', url: '/api/auth/switch-org', headers: old, payload: { orgId: 'org-B' } });
    const res = await app.inject({ method: 'GET', url: '/api/tasks/task-A', headers: old });
    expect(res.statusCode).toBe(200);
    // でも B のデータは見えない
    expect((await app.inject({ method: 'GET', url: '/api/tasks/task-B', headers: old })).statusCode).toBe(404);
  });
});

describe('GET /api/auth/memberships', () => {
  it('有効な所属だけを古い順に返す（無効化された C は出ない）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/memberships', headers: bearer('org-A') });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { orgId: 'org-A', orgName: 'A社', plan: 'STARTER', role: 'OWNER' },
      { orgId: 'org-B', orgName: 'B社', plan: 'PRO', role: 'MEMBER' },
    ]);
  });
});

describe('POST /api/auth/login（S5 / S6）', () => {
  const login = (email: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password123' } });

  it('最後に選んだ組織（User.orgId）の所属が有効ならそこに入る', async () => {
    user('u-t').orgId = 'org-B';
    const res = await login('t@example.com');
    expect(decode(res.json().data.token).orgId).toBe('org-B');
    expect(res.json().data.memberships).toHaveLength(2);
  });

  it('S5: 最後に選んだ組織の所属が無効なら、最も古い有効な組織', async () => {
    user('u-t').orgId = 'org-C';
    const res = await login('t@example.com');
    expect(decode(res.json().data.token).orgId).toBe('org-A');
  });

  it('S5: 有効な所属が1つも無ければ orgId=null のトークンと空の memberships（UC7）', async () => {
    for (const m of fake.rows('membership')) if (m.userId === 'u-t') m.status = 'DISABLED';
    const res = await login('t@example.com');
    expect(res.statusCode).toBe(200);
    expect(decode(res.json().data.token).orgId).toBeNull();
    expect(res.json().data.memberships).toEqual([]);
    // そのトークンではテナントの API は 403 TENANT_REQUIRED
    const t = await app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: `Bearer ${res.json().data.token}` } });
    expect(t.statusCode).toBe(403);
    expect(t.json().error.code).toBe('TENANT_REQUIRED');
  });

  it('S6: 無効化されたアカウントは 401', async () => {
    const res = await login('d@example.com');
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/organizations（組織の作成）', () => {
  it('作った本人が OWNER になり、既定のノードが入り、新しい組織用のトークンが返る', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/organizations', headers: bearer('org-B'), payload: { name: '新会社' } });
    expect(res.statusCode).toBe(201);
    const orgId = res.json().data.organization.id as string;
    expect(decode(res.json().data.token).orgId).toBe(orgId);
    expect(fake.rows('organization').find((o) => o.id === orgId)?.createdBy).toBe('u-t');
    expect(fake.rows('membership').find((m) => m.orgId === orgId)).toMatchObject({ userId: 'u-t', role: 'OWNER' });
    const caps = fake.rows('capability').filter((c) => c.orgId === orgId);
    expect(caps).toHaveLength(DEFAULT_CAPABILITIES.length);
    expect(user('u-t').orgId).toBe(orgId);
    // そのトークンで新しい組織を使える
    const t = await app.inject({ method: 'GET', url: '/api/tasks', headers: { authorization: `Bearer ${res.json().data.token}` } });
    expect(t.statusCode).toBe(200);
  });

  it('所属組織が無いユーザーでも作れる（UC7）', async () => {
    fake.tables.membership = [];
    const res = await app.inject({ method: 'POST', url: '/api/organizations', headers: bearer(null), payload: { name: '再出発' } });
    expect(res.statusCode).toBe(201);
  });

  it(`⚠️ 作成できるのは1ユーザー ${MAX_ORGS_CREATED_PER_USER} 組織まで（Q10）`, async () => {
    for (let i = 0; i < MAX_ORGS_CREATED_PER_USER - 1; i++) {
      fake.rows('organization').push({ id: `org-made-${i}`, name: 'x', plan: 'STARTER', createdBy: 'u-t', createdAt: t0 });
    }
    // org-A を合わせて上限ちょうど
    const res = await app.inject({ method: 'POST', url: '/api/organizations', headers: bearer('org-A'), payload: { name: 'もう1つ' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ORG_LIMIT_REACHED');
  });

  it('D4: すでに組織を作った人の2つ目は作成時点で期限切れ。決済設定済みなら書き込みは 402、閲覧は通る', async () => {
    const before = Date.now();
    const res = await app.inject({ method: 'POST', url: '/api/organizations', headers: bearer('org-A'), payload: { name: '2つ目' } });
    expect(res.statusCode).toBe(201);
    const orgId = res.json().data.organization.id as string;
    const created = fake.rows('organization').find((o) => o.id === orgId)!;
    const ends = (created.trialEndsAt as Date).getTime();
    expect(ends).toBeGreaterThanOrEqual(before);
    expect(ends).toBeLessThanOrEqual(Date.now());

    const original = process.env.STRIPE_SECRET_KEY;
    const originalPrice = process.env.STRIPE_PRICE_STARTER_MONTHLY;
    const originalWebhook = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_s_m';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    try {
      const h = { authorization: `Bearer ${res.json().data.token}` };
      const w = await app.inject({ method: 'POST', url: '/api/tasks', headers: h, payload: { title: 'x' } });
      expect(w.statusCode).toBe(402);
      expect(w.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
      const r = await app.inject({ method: 'GET', url: '/api/tasks', headers: h });
      expect(r.statusCode).toBe(200);
    } finally {
      if (original === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = original;
      if (originalPrice === undefined) delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
      else process.env.STRIPE_PRICE_STARTER_MONTHLY = originalPrice;
      if (originalWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = originalWebhook;
    }
  });

  it('D1: まだ組織を作っていない人（招待で入っただけ）の最初の組織には 30 日のトライアルが付く', async () => {
    // org-A の作成者を別人にして、u-t は「自分で作った組織が無い」状態にする
    fake.rows('organization').find((o) => o.id === 'org-A')!.createdBy = 'u-x';
    const res = await app.inject({ method: 'POST', url: '/api/organizations', headers: bearer('org-A'), payload: { name: '最初' } });
    expect(res.statusCode).toBe(201);
    const created = fake.rows('organization').find((o) => o.id === res.json().data.organization.id)!;
    const days = ((created.trialEndsAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('組織名が空なら 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/organizations', headers: bearer('org-A'), payload: { name: '  ' } });
    expect(res.statusCode).toBe(400);
  });
});
