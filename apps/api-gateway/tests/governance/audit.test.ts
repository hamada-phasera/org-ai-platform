import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { FakePrisma } from '../helpers/fake-prisma';

// チャンク 7: 管理操作の監査（services/audit.ts / GET /api/governance/audit）。
// 本物の requireAuth / tenantDb を通し、DB だけをメモリ内の偽 Prisma に差し替える。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { memberRoutes } = await import('../../src/routes/members');
const { governanceRoutes } = await import('../../src/routes/governance');
const { organizationRoutes } = await import('../../src/routes/organizations');
const { integrationsRoutes } = await import('../../src/routes/integrations');
const { sanitizeAuditMeta, recordAudit, REDACTED } = await import('../../src/services/audit');

const SECRET = 'audit-test-secret-32-characters!!!!';
const now = new Date('2026-11-01T00:00:00Z');

function seed() {
  const org = (X: string) => ({
    id: `org-${X}`, name: `${X}社`, plan: 'STARTER', billingEmail: null, subscriptionStatus: null, trialEndsAt: null, storageUsedBytes: BigInt(0), storageAddonUnits: 0, createdAt: now,
  });
  return {
    organization: [org('A'), org('B')],
    user: [
      { id: 'u-owner', email: 'owner@a.jp', name: 'オーナー', status: 'ACTIVE', role: 'OWNER', orgId: 'org-A', createdAt: now },
      { id: 'u-admin', email: 'admin@a.jp', name: '管理者', status: 'ACTIVE', role: 'ADMIN', orgId: 'org-A', createdAt: now },
      { id: 'u-member', email: 'member@a.jp', name: 'メンバー', status: 'ACTIVE', role: 'MEMBER', orgId: 'org-A', createdAt: now },
      { id: 'u-b', email: 'b@b.jp', name: 'B社の人', status: 'ACTIVE', role: 'OWNER', orgId: 'org-B', createdAt: now },
    ],
    membership: [
      { id: 'm1', userId: 'u-owner', orgId: 'org-A', role: 'OWNER', status: 'ACTIVE', createdAt: now },
      { id: 'm2', userId: 'u-admin', orgId: 'org-A', role: 'ADMIN', status: 'ACTIVE', createdAt: now },
      { id: 'm3', userId: 'u-member', orgId: 'org-A', role: 'MEMBER', status: 'ACTIVE', createdAt: now },
      { id: 'm4', userId: 'u-b', orgId: 'org-B', role: 'OWNER', status: 'ACTIVE', createdAt: now },
    ],
    invitation: [],
    providerConnection: [
      { id: 'pc-A', orgId: 'org-A', provider: 'slack', accessTokenEnc: 'enc-secret', refreshTokenEnc: null, tokenExpiresAt: null,
        scopes: null, externalAccountId: 'T1', displayName: 'WS-A', status: 'CONNECTED', lastCheckedAt: null, createdAt: now, updatedAt: now },
    ],
    requiredCredential: [],
    capability: [],
    auditEvent: [
      { id: 'audit-B', orgId: 'org-B', actorId: 'u-b', action: 'member.role_change', targetType: 'user', targetId: 'u-x',
        meta: { role: 'ADMIN', note: 'secret-of-B' }, createdAt: now },
    ],
  };
}

let app: FastifyInstance;
async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(jwt, { secret: SECRET });
  registerTenantContext(a);
  await a.register(memberRoutes, { prefix: '/api/members' });
  await a.register(governanceRoutes, { prefix: '/api/governance' });
  await a.register(organizationRoutes, { prefix: '/api/organizations' });
  await a.register(integrationsRoutes, { prefix: '/api/integrations' });
  await a.ready();
  return a;
}
const as = (sub: string, orgId = 'org-A') => ({
  authorization: `Bearer ${app.jwt.sign({ sub, orgId, role: 'OWNER', email: `${sub}@x.jp` })}`,
});
const auditRows = (orgId = 'org-A') => fake.rows('auditEvent').filter((r) => r.orgId === orgId);

beforeEach(async () => {
  fake = new FakePrisma(seed());
  clearMembershipCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  if (!app) app = await build();
});

describe('書く', () => {
  it('役割変更で AuditEvent が 1 行でき、操作者・対象・新しい役割が残る', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/u-member/role', headers: as('u-owner'), payload: { role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(200);
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: 'org-A', actorId: 'u-owner', action: 'member.role_change', targetType: 'user', targetId: 'u-member',
      meta: { role: 'ADMIN' },
    });
  });

  it('失敗した操作（他組織のメンバー → 404）は記録しない', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/members/u-b/role', headers: as('u-owner'), payload: { role: 'MEMBER' },
    });
    expect(res.statusCode).toBe(404);
    expect(auditRows()).toHaveLength(0);
    expect(auditRows('org-B')).toHaveLength(1);
  });

  it('無効化・招待・招待の取り消し・組織名の変更・連携の切断も残る', async () => {
    await app.inject({ method: 'PATCH', url: '/api/members/u-member/status', headers: as('u-owner'), payload: { status: 'DISABLED' } });
    const inv = await app.inject({ method: 'POST', url: '/api/members/invitations', headers: as('u-owner'), payload: { email: 'New@A.jp', role: 'MEMBER' } });
    expect(inv.statusCode).toBe(201);
    await app.inject({ method: 'DELETE', url: `/api/members/invitations/${inv.json().data.id}`, headers: as('u-owner') });
    await app.inject({ method: 'PATCH', url: '/api/organizations/me', headers: as('u-owner'), payload: { name: '新しい名前' } });
    const del = await app.inject({ method: 'DELETE', url: '/api/integrations/slack', headers: as('u-admin') });
    expect(del.statusCode).toBe(200);

    expect(auditRows().map((r) => r.action)).toEqual([
      'member.status_change', 'member.invite', 'member.invite_revoke', 'org.update', 'integration.disconnect',
    ]);
    // 招待のメールは小文字で保存・記録される
    expect(auditRows()[1].meta).toEqual({ email: 'new@a.jp', role: 'MEMBER' });
  });

  it('⚠️ 招待の生トークンは監査に入らない', async () => {
    const inv = await app.inject({ method: 'POST', url: '/api/members/invitations', headers: as('u-owner'), payload: { email: 'x@a.jp' } });
    const token = inv.json().data.token as string;
    expect(token).toBeTruthy();
    expect(JSON.stringify(fake.rows('auditEvent'))).not.toContain(token);
  });

  it('⚠️ 連携の切断で暗号化済みトークンも監査に入らない', async () => {
    await app.inject({ method: 'DELETE', url: '/api/integrations/slack', headers: as('u-admin') });
    expect(JSON.stringify(auditRows())).not.toContain('enc-secret');
    expect(auditRows()[0].meta).toEqual({ provider: 'slack', account: 'WS-A' });
  });
});

describe('GET /api/governance/audit', () => {
  it('自組織の記録だけが新しい順に出る。他組織の監査は見えない', async () => {
    await app.inject({ method: 'PATCH', url: '/api/members/u-member/role', headers: as('u-owner'), payload: { role: 'ADMIN' } });
    const res = await app.inject({ method: 'GET', url: '/api/governance/audit', headers: as('u-admin') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ action: 'member.role_change', actorId: 'u-owner', actorName: 'オーナー' });
    expect(body.pagination.total).toBe(1);
    expect(res.body).not.toContain('audit-B');
    expect(res.body).not.toContain('secret-of-B');
    expect(res.body).not.toContain('u-b');
  });

  it('B 社のトークンでは B 社の記録だけ', async () => {
    await app.inject({ method: 'PATCH', url: '/api/members/u-member/role', headers: as('u-owner'), payload: { role: 'ADMIN' } });
    const res = await app.inject({ method: 'GET', url: '/api/governance/audit', headers: as('u-b', 'org-B') });
    expect(res.json().data.map((e: { id: string }) => e.id)).toEqual(['audit-B']);
  });

  it('メンバーは 403（管理者以上）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/governance/audit', headers: as('u-member') });
    expect(res.statusCode).toBe(403);
  });

  it('limit は 100 まで', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/governance/audit?limit=5000&page=x', headers: as('u-admin') });
    expect(res.json().pagination).toMatchObject({ page: 1, limit: 100 });
  });
});

describe('sanitizeAuditMeta', () => {
  it('⚠️ 秘密らしいキーの値は落とす（入れ子も）', () => {
    const out = sanitizeAuditMeta({
      role: 'ADMIN',
      token: 'raw-invite-token',
      botToken: 'xoxb-123',
      password: 'p',
      apiKey: 'k',
      nested: { client_secret: 's', Authorization: 'Bearer x', plan: 'PRO' },
    });
    expect(out).toEqual({
      role: 'ADMIN', token: REDACTED, botToken: REDACTED, password: REDACTED, apiKey: REDACTED,
      nested: { client_secret: REDACTED, Authorization: REDACTED, plan: 'PRO' },
    });
    const s = JSON.stringify(out);
    for (const v of ['raw-invite-token', 'xoxb-123', 'Bearer x']) expect(s).not.toContain(v);
  });

  it('長い文字列は切る・入力は書き換えない・未指定は undefined', () => {
    const input = { name: 'あ'.repeat(500) };
    const out = sanitizeAuditMeta(input)!;
    expect((out.name as string).length).toBeLessThanOrEqual(201);
    expect(input.name.length).toBe(500);
    expect(sanitizeAuditMeta(undefined)).toBeUndefined();
  });

  it('記録に失敗しても例外にしない（操作は止めない）', async () => {
    const db = { orgId: 'org-A', auditEvent: { create: vi.fn(async () => { throw new Error('db down'); }) } };
    await expect(recordAudit(db as never, { action: 'org.update', actorId: 'u' })).resolves.toBeUndefined();
  });
});
