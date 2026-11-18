import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { FakePrisma } from '../helpers/fake-prisma';
import { HEADING_DEFINITION, orgRow, pageRow, sampleUpsert } from './fixtures';

// n8n からの業務ページの登録（/api/webhooks/n8n/pages。docs/design/custom-pages.md §5.3・§5.4）。
// 登録トークン（組織ごと・ハッシュ保存）だけで組織が決まり、共有トークンでは通らないこと（K4・T5〜T7）。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

const { n8nPageRoutes } = await import('../../src/routes/n8n-pages');
const { registerRateLimit } = await import('../../src/middleware/rate-limit');
const { hashPageToken } = await import('../../src/services/pages/page-token');
const { definitionHashOf } = await import('../../src/services/pages/upsert');

const TOKEN_A = `flowpg_${'a'.repeat(43)}`;
const TOKEN_A_REVOKED = `flowpg_${'r'.repeat(43)}`;
const TOKEN_B = `flowpg_${'b'.repeat(43)}`;
const URL_BASE = '/api/webhooks/n8n/pages';

function tokenRow(id: string, orgId: string, raw: string, revokedAt: Date | null = null) {
  return { id, orgId, label: id, tokenHash: hashPageToken(raw), prefix: raw.slice(0, 10), lastUsedAt: null, revokedAt, createdBy: 'u', createdAt: new Date() };
}

function seed(): FakePrisma {
  return new FakePrisma({
    organization: [orgRow('org-A'), orgRow('org-B')],
    customPage: [
      pageRow({ id: 'p-B', orgId: 'org-B', slug: 'inquiries', title: 'B の問い合わせ', definition: HEADING_DEFINITION, definitionHash: 'hb' }),
      pageRow({ id: 'p-A-manual', orgId: 'org-A', slug: 'handmade', source: 'MANUAL' }),
      pageRow({ id: 'p-A-seed', orgId: 'org-A', slug: 'seeded', source: 'SEED' }),
    ],
    pageToken: [
      tokenRow('tok-A', 'org-A', TOKEN_A),
      tokenRow('tok-A-old', 'org-A', TOKEN_A_REVOKED, new Date('2026-10-01T00:00:00Z')),
      tokenRow('tok-B', 'org-B', TOKEN_B),
    ],
    auditEvent: [],
  });
}

async function build(withRateLimit = false): Promise<FastifyInstance> {
  const a = Fastify();
  if (withRateLimit) await registerRateLimit(a);
  await a.register(n8nPageRoutes, { prefix: URL_BASE });
  await a.ready();
  return a;
}

let app: FastifyInstance;
const ENV_KEYS = ['APP_BASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_WEBHOOK_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.APP_BASE_URL = 'https://app.example.test/';
  fake = seed();
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

const put = (slug: string, payload: unknown, token: string | null = TOKEN_A, extraHeaders: Record<string, string> = {}) =>
  app.inject({
    method: 'PUT',
    url: `${URL_BASE}/${slug}`,
    headers: { ...(token ? { 'x-page-token': token } : {}), ...extraHeaders },
    payload: payload as Record<string, unknown>,
  });
const pagesOf = (orgId: string) => fake.rows('customPage').filter((p) => p.orgId === orgId);
const bRows = () => JSON.stringify([...fake.rows('customPage'), ...fake.rows('pageToken'), ...fake.rows('auditEvent')].filter((r) => r.orgId === 'org-B'));

describe('認証（x-page-token）', () => {
  it.each([
    ['ヘッダなし', null],
    ['形が違う', 'not-a-token'],
    ['存在しない', `flowpg_${'z'.repeat(43)}`],
    ['失効済み', TOKEN_A_REVOKED],
  ])('%s は一律 401', async (_n, token) => {
    const res = await put('new-page', sampleUpsert(), token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(pagesOf('org-A')).toHaveLength(2);
  });

  it('共有トークン（x-webhook-token / x-org-ai-token）では登録できない（T7）', async () => {
    const shared = 'org-ai-n8n-secret-token';
    const res = await put('new-page', sampleUpsert(), null, { 'x-webhook-token': shared, 'x-org-ai-token': shared });
    expect(res.statusCode).toBe(401);
    expect(fake.rows('customPage')).toHaveLength(3);
  });

  it('一覧（GET）と削除（DELETE）もトークンが要る', async () => {
    expect((await app.inject({ method: 'GET', url: URL_BASE })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `${URL_BASE}/inquiries` })).statusCode).toBe(401);
    expect(fake.rows('customPage')).toHaveLength(3);
  });
});

describe('PUT /api/webhooks/n8n/pages/:slug', () => {
  it('新規は下書き・N8N で作られ、URL を返す。2 回目は changed: false（冪等）', async () => {
    const first = await put('orders', sampleUpsert());
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toEqual({
      slug: 'orders', version: 1, status: 'DRAFT', changed: true, url: 'https://app.example.test/p/orders',
    });
    const row = pagesOf('org-A').find((p) => p.slug === 'orders')!;
    expect(row).toMatchObject({ source: 'N8N', status: 'DRAFT', minRole: 'MEMBER', icon: 'inbox', createdBy: null, schemaVersion: 1 });
    expect(row.definitionHash).toBe(definitionHashOf(sampleUpsert().definition));

    const second = await put('orders', sampleUpsert());
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ version: 1, changed: false });
    expect(fake.rows('auditEvent').filter((e) => e.action === 'page.upsert')).toHaveLength(1);
  });

  it('キーの順番が違うだけの定義は同じもの（version は上がらない）', async () => {
    await put('orders', sampleUpsert());
    const reordered = sampleUpsert();
    reordered.definition = { blocks: reordered.definition.blocks, actions: reordered.definition.actions };
    const res = await put('orders', { definition: reordered.definition, icon: 'inbox', title: '問い合わせ' });
    expect(res.json().data).toMatchObject({ version: 1, changed: false });
  });

  it('定義が変われば version + 1。status を書かなければ管理者が公開した状態を保つ', async () => {
    await put('orders', sampleUpsert());
    const row = pagesOf('org-A').find((p) => p.slug === 'orders')!;
    row.status = 'PUBLISHED'; // 管理者が画面で公開した
    row.sortOrder = 5;
    const res = await put('orders', sampleUpsert({ definition: HEADING_DEFINITION }));
    expect(res.json().data).toMatchObject({ version: 2, changed: true, status: 'PUBLISHED' });
    expect(pagesOf('org-A').find((p) => p.slug === 'orders')).toMatchObject({ status: 'PUBLISHED', sortOrder: 5, version: 2 });
  });

  it('status: PUBLISHED と書けば即公開（監査に page.publish）', async () => {
    await put('orders', sampleUpsert());
    const res = await put('orders', sampleUpsert({ status: 'PUBLISHED' }));
    expect(res.json().data).toMatchObject({ status: 'PUBLISHED', changed: true, version: 1 });
    expect(fake.rows('auditEvent').some((e) => e.action === 'page.publish')).toBe(true);
  });

  it('監査は actorId = null、meta.registrarId に登録トークンの id（値ではない。K26）。lastUsedAt が入る', async () => {
    await put('orders', sampleUpsert());
    const ev = fake.rows('auditEvent').find((e) => e.action === 'page.upsert')!;
    expect(ev).toMatchObject({ orgId: 'org-A', actorId: null });
    expect(ev.meta).toMatchObject({ slug: 'orders', version: 1, registrarId: 'tok-A' });
    expect(JSON.stringify(fake.rows('auditEvent'))).not.toContain(TOKEN_A);
    expect(fake.rows('pageToken').find((t) => t.id === 'tok-A')!.lastUsedAt).toBeInstanceOf(Date);
  });

  it('組織 A のトークンで B と同じ slug を登録しても A に作られ、B は 1 バイトも変わらない（T1・T5）', async () => {
    const before = bRows();
    const res = await put('inquiries', sampleUpsert());
    expect(res.statusCode).toBe(201);
    expect(pagesOf('org-A').some((p) => p.slug === 'inquiries')).toBe(true);
    expect(bRows()).toBe(before);
  });

  it('body に orgId を書いても受け付けない（組織はトークンが決める）', async () => {
    const before = bRows();
    const res = await put('orders', sampleUpsert({ orgId: 'org-B' }));
    expect(res.statusCode).toBe(400);
    expect(bRows()).toBe(before);
    expect(pagesOf('org-A').some((p) => p.slug === 'orders')).toBe(false);
  });

  it('sampleData / source は受け付けない（T16）', async () => {
    expect((await put('orders', sampleUpsert({ sampleData: { list: { open: 1 } } }))).statusCode).toBe(400);
    expect((await put('orders', sampleUpsert({ source: 'SEED' }))).statusCode).toBe(400);
  });

  it('人が作ったページ（MANUAL / SEED）は上書きできない（409 PAGE_SOURCE_CONFLICT）', async () => {
    for (const slug of ['handmade', 'seeded']) {
      const res = await put(slug, sampleUpsert({ definition: HEADING_DEFINITION }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PAGE_SOURCE_CONFLICT');
    }
    expect(pagesOf('org-A').find((p) => p.slug === 'handmade')!.version).toBe(1);
  });

  it('ページ数の上限で新規だけ 403 PAGE_LIMIT_REACHED（既存の N8N ページの更新は通る）', async () => {
    fake.rows('organization').find((o) => o.id === 'org-B')!.plan = 'STARTER';
    const res = await put('second', sampleUpsert(), TOKEN_B);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PAGE_LIMIT_REACHED');
    const update = await put('inquiries', sampleUpsert(), TOKEN_B);
    expect(update.statusCode).toBe(200);
    expect(update.json().data).toMatchObject({ version: 2, changed: true });
  });

  it('不正な定義は「場所: 理由」で最大 3 件。値そのものは本文に出さない', async () => {
    const bad = sampleUpsert({ icon: '<img src=x onerror=alert(1)>' });
    bad.definition.blocks.push({ type: 'html', html: '<script>alert(1)</script>' } as never);
    bad.definition.actions.list.hook = 'https://evil.example/x';
    const res = await put('orders', bad);
    expect(res.statusCode).toBe(400);
    const msg = res.json().error.message as string;
    expect(msg).toMatch(/icon: /);
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('onerror');
    expect(res.body).not.toContain('evil.example');
  });

  it.each(['Bad_Slug', 'a..b', '-x', 'x'.repeat(41)])('slug「%s」は 400', async (slug) => {
    const res = await put(encodeURIComponent(slug), sampleUpsert());
    expect(res.statusCode).toBe(400);
  });

  it('予約された slug は 400', async () => {
    expect((await put('tokens', sampleUpsert())).statusCode).toBe(400);
  });

  it('64KB を超える本文は 413 PAYLOAD_TOO_LARGE（統一の形・日本語。Fastify の既定の本文を返さない）', async () => {
    const huge = sampleUpsert({ title: 'x', definition: { ...sampleUpsert().definition, pad: 'x'.repeat(70 * 1024) } });
    const res = await put('orders', huge);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: '登録する本文が大きすぎます（64KB まで）。' },
    });
    expect(res.body).not.toContain('FST_ERR');
    expect(pagesOf('org-A')).toHaveLength(2);
  });
});

describe('DELETE /api/webhooks/n8n/pages/:slug', () => {
  it('N8N のページを消す（監査に page.delete）。無ければ 200 deleted: false', async () => {
    await put('orders', sampleUpsert());
    const res = await app.inject({ method: 'DELETE', url: `${URL_BASE}/orders`, headers: { 'x-page-token': TOKEN_A } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ deleted: true });
    expect(fake.rows('auditEvent').some((e) => e.action === 'page.delete' && (e.meta as Record<string, unknown>).registrarId === 'tok-A')).toBe(true);

    const again = await app.inject({ method: 'DELETE', url: `${URL_BASE}/orders`, headers: { 'x-page-token': TOKEN_A } });
    expect(again.json().data).toEqual({ deleted: false });
  });

  it('A のトークンで B のページは消えない（A に無いので deleted: false）', async () => {
    const before = bRows();
    const res = await app.inject({ method: 'DELETE', url: `${URL_BASE}/inquiries`, headers: { 'x-page-token': TOKEN_A } });
    expect(res.json().data).toEqual({ deleted: false });
    expect(bRows()).toBe(before);
  });

  it('MANUAL / SEED のページは 409', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${URL_BASE}/handmade`, headers: { 'x-page-token': TOKEN_A } });
    expect(res.statusCode).toBe(409);
    expect(pagesOf('org-A').some((p) => p.slug === 'handmade')).toBe(true);
  });
});

describe('GET /api/webhooks/n8n/pages', () => {
  it('その組織の N8N 製のページだけ（slug・version・status）', async () => {
    await put('orders', sampleUpsert());
    const res = await app.inject({ method: 'GET', url: URL_BASE, headers: { 'x-page-token': TOKEN_A } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((p: { slug: string }) => p.slug)).toEqual(['orders']);
    expect(Object.keys(res.json().data[0]).sort()).toEqual(['slug', 'status', 'updatedAt', 'version']);
    expect(res.body).not.toContain('inquiries-list');
  });
});

describe('閲覧のみの組織（T12）', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    Object.assign(fake.rows('organization').find((o) => o.id === 'org-A')!, {
      subscriptionStatus: 'canceled',
      trialEndsAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('登録と削除は 402、一覧は通る', async () => {
    const res = await put('orders', sampleUpsert());
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    const del = await app.inject({ method: 'DELETE', url: `${URL_BASE}/handmade`, headers: { 'x-page-token': TOKEN_A } });
    expect(del.statusCode).toBe(402);
    expect(pagesOf('org-A')).toHaveLength(2);
    const list = await app.inject({ method: 'GET', url: URL_BASE, headers: { 'x-page-token': TOKEN_A } });
    expect(list.statusCode).toBe(200);
  });

  it('契約中の B には影響しない', async () => {
    expect((await put('orders', sampleUpsert(), TOKEN_B)).statusCode).toBe(201);
  });
});

describe('レート制限（T6）', () => {
  it('IP ごとに 1 分 20 回。21 回目は 429 RATE_LIMITED', async () => {
    const limited = await build(true);
    try {
      const codes: number[] = [];
      for (let i = 0; i < 21; i++) {
        const res = await limited.inject({ method: 'PUT', url: `${URL_BASE}/x`, headers: { 'x-page-token': 'wrong' }, payload: {} });
        codes.push(res.statusCode);
      }
      expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
      expect(codes[20]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
