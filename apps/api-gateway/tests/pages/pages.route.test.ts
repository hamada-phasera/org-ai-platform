import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { createHash } from 'crypto';
import { FakePrisma } from '../helpers/fake-prisma';
import { HEADING_DEFINITION, orgRow, pageRow, sampleUpsert, userAndMembership } from './fixtures';

// 業務ページの利用者向け API（/api/pages。docs/design/custom-pages.md §5.1）。
// 本物の requireAuth / requireRole / tenantDb を通し、DB だけを偽 Prisma に差し替える。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { pageRoutes } = await import('../../src/routes/pages');

const SECRET = 'pages-route-test-secret-32-chars-long!!';

function seed(): FakePrisma {
  const people = [
    userAndMembership('u-owner', 'org-A', 'OWNER'),
    userAndMembership('u-admin', 'org-A', 'ADMIN'),
    userAndMembership('u-member', 'org-A', 'MEMBER'),
    userAndMembership('u-b', 'org-B', 'OWNER'),
  ];
  return new FakePrisma({
    organization: [orgRow('org-A'), orgRow('org-B')],
    user: people.map((p) => p.user),
    membership: people.map((p) => p.membership),
    customPage: [
      pageRow({ id: 'p-pub', orgId: 'org-A', slug: 'inquiries', title: '問い合わせ', sortOrder: 2 }),
      pageRow({ id: 'p-draft', orgId: 'org-A', slug: 'draft-page', title: '下書き', status: 'DRAFT', sortOrder: 1 }),
      pageRow({ id: 'p-admin', orgId: 'org-A', slug: 'admin-only', title: '管理者用', minRole: 'ADMIN', definition: HEADING_DEFINITION }),
      pageRow({ id: 'p-owner', orgId: 'org-A', slug: 'owner-only', title: '経営', minRole: 'OWNER', definition: HEADING_DEFINITION }),
      pageRow({ id: 'p-B', orgId: 'org-B', slug: 'b-secret', title: 'B専用' }),
    ],
    pageToken: [],
    pageActionLog: [],
    auditEvent: [],
  });
}

let app: FastifyInstance;
async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(jwt, { secret: SECRET });
  registerTenantContext(a);
  await a.register(pageRoutes, { prefix: '/api/pages' });
  await a.ready();
  return a;
}
const as = (sub: string, orgId = 'org-A') => ({ authorization: `Bearer ${app.jwt.sign({ sub, orgId, role: 'OWNER' })}` });
const OWNER = () => as('u-owner');
const ADMIN = () => as('u-admin');
const MEMBER = () => as('u-member');

const ENV_KEYS = ['N8N_URL', 'N8N_CLOUD_URL', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_WEBHOOK_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  fake = seed();
  clearMembershipCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  if (!app) app = await build();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

const audits = (action: string) => fake.rows('auditEvent').filter((e) => e.action === action);

describe('GET /api/pages（ナビの一覧）', () => {
  it('メンバーには公開済みかつ minRole を満たすものだけ', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages', headers: MEMBER() });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((p: { slug: string }) => p.slug)).toEqual(['inquiries']);
  });

  it('管理者には下書きも出るが、オーナー限定は出ない。sortOrder の順', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages', headers: ADMIN() });
    expect(res.json().data.map((p: { slug: string }) => p.slug)).toEqual(['admin-only', 'draft-page', 'inquiries']);
  });

  it('オーナーにはすべて。他組織のページは出ない', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages', headers: OWNER() });
    const slugs = res.json().data.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining(['inquiries', 'draft-page', 'admin-only', 'owner-only']));
    expect(res.body).not.toContain('b-secret');
    expect(res.body).not.toContain('B専用');
  });

  it('一覧の項目は slug・title・icon・status だけ（定義や hook は出ない）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages', headers: OWNER() });
    expect(Object.keys(res.json().data[0]).sort()).toEqual(['icon', 'slug', 'status', 'title']);
    expect(res.body).not.toContain('inquiries-list');
  });

  it('認証なしは 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/pages/:slug', () => {
  it('定義を返すが hook は返さない（T17）。connection と usage を添える', async () => {
    fake.rows('pageActionLog').push({
      id: 'l1', orgId: 'org-A', pageId: 'p-pub', slug: 'inquiries', actionId: 'create', pageVersion: 1, actorId: 'u-member',
      requestId: 'r1', status: 'OK', durationMs: 10, inputKeys: ['name'], createdAt: new Date(),
    });
    const res = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: MEMBER() });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.slug).toBe('inquiries');
    expect(data.definition.blocks).toHaveLength(4);
    expect(data.definition.actions.list).toEqual({ kind: 'query' });
    expect(data.definition.actions.done).toEqual({ kind: 'submit', confirm: '対応済みにしますか' });
    expect(res.body).not.toContain('hook');
    expect(res.body).not.toContain('inquiries-list');
    expect(res.body).not.toContain('inquiries-submit');
    expect(data.connection).toBe('not_configured');
    expect(data.usage).toMatchObject({ used: 1, limit: 3000, state: 'ok', blocked: false });
  });

  it('n8n の宛先が明示されていれば connection は ok', async () => {
    process.env.N8N_URL = 'https://n8n.example.test';
    const res = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: MEMBER() });
    expect(res.json().data.connection).toBe('ok');
  });

  it.each([
    ['メンバーが下書き', MEMBER, 'draft-page'],
    ['メンバーが管理者用', MEMBER, 'admin-only'],
    ['管理者がオーナー限定', ADMIN, 'owner-only'],
    ['他組織のページ', OWNER, 'b-secret'],
    ['存在しない', OWNER, 'nothing'],
    ['形が不正な slug', OWNER, 'Bad..Slug'],
  ])('%s は 404（存在を漏らさない）', async (_name, who, slug) => {
    const res = await app.inject({ method: 'GET', url: `/api/pages/${encodeURIComponent(slug)}`, headers: who() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(res.body).not.toContain('B専用');
  });

  it('管理者は下書きを開ける', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/draft-page', headers: ADMIN() });
    expect(res.statusCode).toBe(200);
  });

  it('保存済みの定義が壊れていたら描画させない（500 PAGE_INVALID_DEFINITION）', async () => {
    fake.rows('customPage').find((p) => p.id === 'p-pub')!.definition = { blocks: [{ type: 'html', html: '<script>' }], actions: {} };
    const res = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: MEMBER() });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('PAGE_INVALID_DEFINITION');
    expect(res.body).not.toContain('<script>');
  });
});

describe('GET /api/pages/admin/list', () => {
  it('管理者は管理できるページと利用状況を見る（オーナー限定は出ないが、ページ数には数える）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/admin/list', headers: ADMIN() });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.pages.map((p: { slug: string }) => p.slug).sort()).toEqual(['admin-only', 'draft-page', 'inquiries']);
    expect(data.pages[0]).toHaveProperty('version');
    expect(data.pages[0]).toHaveProperty('source');
    expect(data.pageCount).toBe(4);
    expect(data.plan).toBe('PRO');
    expect(data.orgId).toBe('org-A');
    expect(data.usage).toMatchObject({ used: 0, limit: 3000 });
    expect(res.body).not.toContain('inquiries-list');
  });

  it('メンバーは 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pages/admin/list', headers: MEMBER() });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /api/pages/:slug', () => {
  it('管理者が公開する（監査に page.publish）', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/pages/draft-page', headers: ADMIN(), payload: { status: 'PUBLISHED' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'PUBLISHED', changed: true });
    expect(fake.rows('customPage').find((p) => p.id === 'p-draft')!.status).toBe('PUBLISHED');
    expect(audits('page.publish')).toHaveLength(1);
    expect(audits('page.publish')[0]).toMatchObject({ orgId: 'org-A', actorId: 'u-admin', targetId: 'p-draft' });
    // メンバーの一覧に出るようになる
    const list = await app.inject({ method: 'GET', url: '/api/pages', headers: MEMBER() });
    expect(list.json().data.map((p: { slug: string }) => p.slug)).toContain('draft-page');
  });

  it('非公開に戻すと page.unpublish、並びとタイトルは page.upsert', async () => {
    await app.inject({ method: 'PATCH', url: '/api/pages/inquiries', headers: ADMIN(), payload: { status: 'DRAFT', sortOrder: 9, title: '受付' } });
    expect(audits('page.unpublish')).toHaveLength(1);
    expect(audits('page.upsert')).toHaveLength(1);
    const row = fake.rows('customPage').find((p) => p.id === 'p-pub')!;
    expect(row).toMatchObject({ status: 'DRAFT', sortOrder: 9, title: '受付', updatedBy: 'u-admin' });
  });

  it('同じ値なら何も書かない', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/pages/inquiries', headers: ADMIN(), payload: { status: 'PUBLISHED' } });
    expect(res.json().data.changed).toBe(false);
    expect(fake.rows('auditEvent')).toHaveLength(0);
  });

  it('定義は PATCH で変えられない（知らないキーは 400）', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/pages/inquiries', headers: ADMIN(), payload: { definition: HEADING_DEFINITION },
    });
    expect(res.statusCode).toBe(400);
    const res2 = await app.inject({ method: 'PATCH', url: '/api/pages/inquiries', headers: ADMIN(), payload: { sampleData: {} } });
    expect(res2.statusCode).toBe(400);
  });

  it('許可リストにないアイコンは 400（値は本文に返さない）', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/pages/inquiries', headers: ADMIN(), payload: { icon: '<script>x</script>' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('<script>');
  });

  it('メンバーは 403', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/pages/inquiries', headers: MEMBER(), payload: { status: 'DRAFT' } });
    expect(res.statusCode).toBe(403);
  });

  it('管理者は自分より上の役割を minRole に付けられない', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/pages/inquiries', headers: ADMIN(), payload: { minRole: 'OWNER' } });
    expect(res.statusCode).toBe(403);
    expect(fake.rows('customPage').find((p) => p.id === 'p-pub')!.minRole).toBe('MEMBER');
  });

  it('管理者はオーナー限定のページを触れない（404。minRole を下げて覗く抜け道を塞ぐ）', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/pages/owner-only', headers: ADMIN(), payload: { minRole: 'MEMBER' } });
    expect(res.statusCode).toBe(404);
    expect(fake.rows('customPage').find((p) => p.id === 'p-owner')!.minRole).toBe('OWNER');
  });

  it('他組織のページは 404 で 1 バイトも変わらない', async () => {
    const before = JSON.stringify(fake.rows('customPage').find((p) => p.id === 'p-B'));
    const res = await app.inject({ method: 'PATCH', url: '/api/pages/b-secret', headers: OWNER(), payload: { status: 'DRAFT' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(fake.rows('customPage').find((p) => p.id === 'p-B'))).toBe(before);
  });
});

describe('PUT /api/pages/:slug（手動 upsert）', () => {
  it('新規は MANUAL・下書きで作られ、同じ内容の 2 回目は changed: false', async () => {
    const first = await app.inject({ method: 'PUT', url: '/api/pages/manual-one', headers: ADMIN(), payload: sampleUpsert() });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ slug: 'manual-one', version: 1, status: 'DRAFT', changed: true });
    const row = fake.rows('customPage').find((p) => p.slug === 'manual-one')!;
    expect(row).toMatchObject({ orgId: 'org-A', source: 'MANUAL', createdBy: 'u-admin', sampleData: null });

    const second = await app.inject({ method: 'PUT', url: '/api/pages/manual-one', headers: ADMIN(), payload: sampleUpsert() });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ version: 1, changed: false });
  });

  it('定義が変われば version + 1', async () => {
    await app.inject({ method: 'PUT', url: '/api/pages/manual-one', headers: ADMIN(), payload: sampleUpsert() });
    const res = await app.inject({
      method: 'PUT', url: '/api/pages/manual-one', headers: ADMIN(), payload: sampleUpsert({ definition: HEADING_DEFINITION }),
    });
    expect(res.json().data).toMatchObject({ version: 2, changed: true });
  });

  it('n8n が作ったページを人が上書きすると MANUAL になる（以降 n8n からは上書きされない）', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/pages/inquiries', headers: ADMIN(), payload: sampleUpsert({ title: '手直し' }) });
    expect(res.statusCode).toBe(200);
    expect(fake.rows('customPage').find((p) => p.id === 'p-pub')).toMatchObject({ source: 'MANUAL', title: '手直し' });
  });

  it('プランのページ数の上限で 403 PAGE_LIMIT_REACHED（既存の更新は通る）', async () => {
    fake.rows('organization').find((o) => o.id === 'org-A')!.plan = 'STARTER';
    const res = await app.inject({ method: 'PUT', url: '/api/pages/new-one', headers: OWNER(), payload: sampleUpsert() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PAGE_LIMIT_REACHED');
    const update = await app.inject({ method: 'PUT', url: '/api/pages/inquiries', headers: OWNER(), payload: sampleUpsert() });
    expect(update.statusCode).toBe(200);
  });

  it.each([
    ['sampleData', { sampleData: { list: { open: 999 } } }],
    ['source', { source: 'SEED' }],
    ['orgId', { orgId: 'org-B' }],
  ])('%s は受け付けない（400）', async (_k, extra) => {
    const res = await app.inject({ method: 'PUT', url: '/api/pages/x-page', headers: ADMIN(), payload: sampleUpsert(extra) });
    expect(res.statusCode).toBe(400);
    expect(fake.rows('customPage').some((p) => p.slug === 'x-page')).toBe(false);
  });

  it.each(['admin', 'tokens'])('予約された slug「%s」は 400', async (slug) => {
    const res = await app.inject({ method: 'PUT', url: `/api/pages/${slug}`, headers: ADMIN(), payload: sampleUpsert() });
    expect(res.statusCode).toBe(400);
  });

  it('不正な定義は「場所: 理由」で 400', async () => {
    const bad = sampleUpsert();
    bad.definition.actions.list.hook = '../dept-sales';
    const res = await app.inject({ method: 'PUT', url: '/api/pages/x-page', headers: ADMIN(), payload: bad });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('definition.actions.list.hook');
  });

  it('メンバーは 403、管理者はオーナー限定のページを上書きできない（404）', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/pages/x-page', headers: MEMBER(), payload: sampleUpsert() })).statusCode).toBe(403);
    const res = await app.inject({ method: 'PUT', url: '/api/pages/owner-only', headers: ADMIN(), payload: sampleUpsert() });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/pages/:slug', () => {
  it('管理者が削除（監査に page.delete）。送信の記録は残る', async () => {
    fake.rows('pageActionLog').push({
      id: 'l1', orgId: 'org-A', pageId: 'p-pub', slug: 'inquiries', actionId: 'create', pageVersion: 1, actorId: 'u-member',
      requestId: 'r1', status: 'OK', durationMs: 10, inputKeys: [], createdAt: new Date(),
    });
    const res = await app.inject({ method: 'DELETE', url: '/api/pages/inquiries', headers: ADMIN() });
    expect(res.statusCode).toBe(200);
    expect(fake.rows('customPage').some((p) => p.id === 'p-pub')).toBe(false);
    expect(audits('page.delete')).toHaveLength(1);
    expect(fake.rows('pageActionLog')).toHaveLength(1);
  });

  it('無い・他組織・オーナー限定（管理者）は 404', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/pages/nothing', headers: ADMIN() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/pages/b-secret', headers: OWNER() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/pages/owner-only', headers: ADMIN() })).statusCode).toBe(404);
    expect(fake.rows('customPage')).toHaveLength(5);
  });
});

describe('登録トークン（/api/pages/tokens）', () => {
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  it('オーナーが発行。生トークンは応答に 1 回だけ、DB にはハッシュと先頭 10 文字だけ', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: OWNER(), payload: { label: 'n8n 本番' } });
    expect(res.statusCode).toBe(201);
    const { token, prefix, registerUrlBase } = res.json().data;
    expect(token).toMatch(/^flowpg_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(token.slice(0, 10));
    expect(registerUrlBase).toMatch(/\/api\/webhooks\/n8n\/pages$/);
    const saved = fake.rows('pageToken')[0];
    expect(saved).toMatchObject({ orgId: 'org-A', tokenHash: sha(token), prefix, createdBy: 'u-owner', revokedAt: null });
    expect(JSON.stringify(fake.rows('pageToken'))).not.toContain(token);
    // 監査にも値は入らない
    expect(audits('page_token.issue')).toHaveLength(1);
    expect(JSON.stringify(fake.rows('auditEvent'))).not.toContain(token);

    // 一覧には生値もハッシュも出ない
    const list = await app.inject({ method: 'GET', url: '/api/pages/tokens', headers: OWNER() });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain(sha(token));
    expect(Object.keys(list.json().data[0]).sort()).toEqual(['createdAt', 'id', 'label', 'lastUsedAt', 'prefix', 'revokedAt']);
  });

  it('有効なトークンは 2 本まで（3 本目は 409）。失効すれば発行できる', async () => {
    for (const label of ['一', '二']) {
      expect((await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: OWNER(), payload: { label } })).statusCode).toBe(201);
    }
    const third = await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: OWNER(), payload: { label: '三' } });
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe('PAGE_TOKEN_LIMIT');

    const id = fake.rows('pageToken')[0].id as string;
    const revoke = await app.inject({ method: 'DELETE', url: `/api/pages/tokens/${id}`, headers: OWNER() });
    expect(revoke.statusCode).toBe(200);
    expect(fake.rows('pageToken')[0].revokedAt).toBeInstanceOf(Date);
    expect(audits('page_token.revoke')).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: OWNER(), payload: { label: '三' } })).statusCode).toBe(201);
  });

  it('管理者・メンバーは発行も一覧も失効もできない（403）', async () => {
    for (const who of [ADMIN, MEMBER]) {
      expect((await app.inject({ method: 'GET', url: '/api/pages/tokens', headers: who() })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: who(), payload: { label: 'x' } })).statusCode).toBe(403);
    }
    expect(fake.rows('pageToken')).toHaveLength(0);
  });

  it('ラベルの検証（空・長すぎ・知らないキー）', async () => {
    for (const payload of [{ label: '' }, { label: 'あ'.repeat(25) }, { label: 'x', orgId: 'org-B' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/pages/tokens', headers: OWNER(), payload })).statusCode).toBe(400);
    }
  });

  it('他組織のトークンは失効できない（404・B は変わらない）', async () => {
    fake.rows('pageToken').push({ id: 'tok-B', orgId: 'org-B', label: 'B', tokenHash: 'hb', prefix: 'flowpg_bbb', revokedAt: null, lastUsedAt: null, createdBy: 'u-b', createdAt: new Date() });
    const res = await app.inject({ method: 'DELETE', url: '/api/pages/tokens/tok-B', headers: OWNER() });
    expect(res.statusCode).toBe(404);
    expect(fake.rows('pageToken').find((t) => t.id === 'tok-B')!.revokedAt).toBeNull();
  });
});

describe('閲覧のみ（解約・トライアル切れ）の組織', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    Object.assign(fake.rows('organization').find((o) => o.id === 'org-A')!, {
      subscriptionStatus: 'canceled',
      trialEndsAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('表示（GET）は通る', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/pages', headers: MEMBER() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: MEMBER() })).statusCode).toBe(200);
  });

  it('変更・登録・トークン発行は 402 SUBSCRIPTION_REQUIRED', async () => {
    const reqs = [
      { method: 'PATCH' as const, url: '/api/pages/inquiries', payload: { status: 'DRAFT' } },
      { method: 'PUT' as const, url: '/api/pages/new-one', payload: sampleUpsert() },
      { method: 'DELETE' as const, url: '/api/pages/inquiries' },
      { method: 'POST' as const, url: '/api/pages/tokens', payload: { label: 'x' } },
    ];
    for (const r of reqs) {
      const res = await app.inject({ ...r, headers: OWNER() });
      expect(res.statusCode).toBe(402);
      expect(res.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    }
    expect(fake.rows('customPage')).toHaveLength(5);
    expect(fake.rows('pageToken')).toHaveLength(0);
  });
});
