import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { randomUUID } from 'crypto';
import { PAGE_DEFINITION_LIMITS } from '@org-ai/shared-types';
import { FakePrisma } from '../helpers/fake-prisma';
import { HEADING_DEFINITION, orgRow, pageRow, userAndMembership } from './fixtures';

// 業務ページのアクション実行（GET /api/pages/:slug/data/:actionId・POST /api/pages/:slug/actions/:actionId）。
// docs/design/custom-pages.md §5.2 の 11 段階をルート越しに固定する。DB は偽 Prisma、n8n は fetch のモック（外部通信なし）。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { pageRoutes } = await import('../../src/routes/pages');
const { resetOrgThrottle, PAGE_ORG_THROTTLE } = await import('../../src/services/pages/org-throttle');

const SECRET = 'page-actions-route-test-secret-32-chars!!';
const N8N = 'https://n8n.test';

const SAMPLE_DATA = {
  list: {
    open: 3,
    month: 12,
    rows: [{ id: 'q1', date: '2026-11-01', name: '山田', subject: '見積', status: '未対応', secret: 'drop-me' }],
  },
};

function seed(): FakePrisma {
  const people = [
    userAndMembership('u-owner', 'org-A', 'OWNER'),
    userAndMembership('u-admin', 'org-A', 'ADMIN'),
    userAndMembership('u-member', 'org-A', 'MEMBER'),
    userAndMembership('u-b', 'org-B', 'OWNER'),
  ];
  return new FakePrisma({
    organization: [orgRow('org-A', { plan: 'STARTER' }), orgRow('org-B')],
    user: people.map((p) => p.user),
    membership: people.map((p) => p.membership),
    customPage: [
      pageRow({ id: 'p-pub', orgId: 'org-A', slug: 'inquiries', sampleData: SAMPLE_DATA }),
      pageRow({ id: 'p-draft', orgId: 'org-A', slug: 'draft-page', status: 'DRAFT' }),
      pageRow({ id: 'p-owner', orgId: 'org-A', slug: 'owner-only', minRole: 'OWNER' }),
      pageRow({ id: 'p-broken', orgId: 'org-A', slug: 'broken', definition: { blocks: [{ type: 'iframe' }], actions: {} } }),
      pageRow({ id: 'p-head', orgId: 'org-A', slug: 'heading', definition: HEADING_DEFINITION }),
      pageRow({ id: 'p-B', orgId: 'org-B', slug: 'b-secret' }),
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

const ENV_KEYS = [
  'N8N_URL', 'N8N_CLOUD_URL', 'N8N_WEBHOOK_AUTH_TOKEN', 'PAGES_SAMPLE_MODE', 'NODE_ENV', 'PAGE_ACTION_TIMEOUT_MS',
  'STRIPE_SECRET_KEY', 'STRIPE_PRICE_STARTER_MONTHLY', 'STRIPE_WEBHOOK_SECRET', 'AI_ENGINE_URL',
];
const savedEnv: Record<string, string | undefined> = {};
let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[];

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.N8N_URL = `${N8N}/`;
  process.env.N8N_WEBHOOK_AUTH_TOKEN = 'shared-for-test';
  process.env.AI_ENGINE_URL = 'http://ai.test';
  fake = seed();
  clearMembershipCache();
  resetOrgThrottle();
  fetchMock = vi.fn(async () => jsonRes(SAMPLE_DATA.list));
  vi.stubGlobal('fetch', fetchMock);
  logs = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  if (!app) app = await build();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const data = (slug: string, actionId: string, headers = MEMBER()) =>
  app.inject({ method: 'GET', url: `/api/pages/${slug}/data/${actionId}`, headers });

const FORM_INPUT = { name: '山田', tel: '03-1234-5678', subject: '見積', body: '至急' };
const submit = (
  actionId: string,
  payload: Record<string, unknown> = { input: FORM_INPUT, requestId: randomUUID(), origin: { blockIndex: 2 } },
  headers = MEMBER(),
  slug = 'inquiries',
) => app.inject({ method: 'POST', url: `/api/pages/${slug}/actions/${actionId}`, headers, payload });

const calledUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));
const calledBody = (i = 0) => JSON.parse((fetchMock.mock.calls[i]![1] as RequestInit).body as string) as Record<string, unknown>;

describe('GET /api/pages/:slug/data/:actionId（query）', () => {
  it('pages/<JWT の orgId>/<hook> にだけ POST し、宣言した key と列だけを返す', async () => {
    const res = await data('inquiries', 'list');
    expect(res.statusCode).toBe(200);
    expect(calledUrls()).toEqual([`${N8N}/webhook/pages/org-A/inquiries-list`]);
    const d = res.json().data;
    expect(d).toMatchObject({ action: 'list', sample: false });
    expect(d.blocks[0]).toEqual({ index: 0, type: 'kpi', values: { 0: 3, 1: 12 } });
    expect(d.blocks[1].rows[0]).toEqual({ id: 'q1', cells: { date: '2026-11-01', name: '山田', subject: '見積', status: '未対応' } });
    expect(res.body).not.toContain('drop-me');
    expect(res.body).not.toContain('inquiries-list');
    expect(res.body).not.toContain(N8N);
  });

  it('n8n への body は orgId・page・action・kind・actor（userId と role）・plan。メール・氏名は送らない', async () => {
    await data('inquiries', 'list');
    const body = calledBody();
    expect(body).toMatchObject({
      orgId: 'org-A', page: 'inquiries', action: 'list', kind: 'query', input: {},
      actor: { userId: 'u-member', role: 'MEMBER' }, plan: 'STARTER', readOnly: false, aiEngineUrl: 'http://ai.test',
    });
    expect(typeof body.requestId).toBe('string');
    expect(JSON.stringify(body)).not.toContain('@example.com');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-org-ai-token']).toBe('shared-for-test');
  });

  it('応答の形が違うブロックだけ error（他のブロックは出す）', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ open: 1, month: 2, rows: 'not-array' }));
    const res = await data('inquiries', 'list');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.blocks).toEqual([
      { index: 0, type: 'kpi', values: { 0: 1, 1: 2 } },
      { index: 1, type: 'table', error: 'INVALID_RESPONSE' },
    ]);
  });

  it.each([
    ['存在しない action', 'inquiries', 'nope'],
    ['submit の action を query で', 'inquiries', 'create'],
    ['不正な actionId', 'inquiries', 'Bad-Id'],
    ['下書き（メンバー）', 'draft-page', 'list'],
    ['オーナー限定（メンバー）', 'owner-only', 'list'],
    ['他組織のページ', 'b-secret', 'list'],
    ['存在しないページ', 'missing', 'list'],
  ])('%s は 404 で n8n に届かない', async (_name, slug, actionId) => {
    const res = await data(slug, actionId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('管理者は下書きのデータも取れる（公開前の確認）', async () => {
    expect((await data('draft-page', 'list', ADMIN())).statusCode).toBe(200);
  });

  it('壊れた保存済み定義は 500 PAGE_INVALID_DEFINITION で n8n に届かない', async () => {
    const res = await data('broken', 'list');
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('PAGE_INVALID_DEFINITION');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('n8n 未設定は 503 PAGE_NOT_CONNECTED（フォールバックしない）', async () => {
    delete process.env.N8N_URL;
    const res = await data('inquiries', 'list');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('PAGE_NOT_CONNECTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['500', () => jsonRes({ detail: 'n8n stack trace' }, 500), 502, 'PAGE_UPSTREAM_FAILED'],
    ['HTML', () => new Response('<html>', { headers: { 'content-type': 'text/html' } }), 502, 'PAGE_INVALID_RESPONSE'],
    ['巨大', () => new Response(JSON.stringify({ x: 'y'.repeat(300 * 1024) }), { headers: { 'content-type': 'application/json' } }), 502, 'PAGE_INVALID_RESPONSE'],
  ])('n8n が %s なら統一コード（n8n の本文は返さない）', async (_n, make, status, code) => {
    fetchMock.mockImplementation(async () => make());
    const res = await data('inquiries', 'list');
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ success: false, error: { code } });
    expect(res.body).not.toContain('stack trace');
  });

  it('タイムアウトは 504 PAGE_UPSTREAM_TIMEOUT', async () => {
    process.env.PAGE_ACTION_TIMEOUT_MS = '20';
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const res = await data('inquiries', 'list');
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('PAGE_UPSTREAM_TIMEOUT');
  });

  it('接続エラーは 1 回だけやり直す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await data('inquiries', 'list')).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('組織ごとに 1 分 120 回で 429（組織 B には効かない）', async () => {
    fetchMock.mockImplementation(async () => jsonRes(SAMPLE_DATA.list));
    const { takeOrgActionSlot } = await import('../../src/services/pages/org-throttle');
    for (let i = 0; i < PAGE_ORG_THROTTLE.query; i++) takeOrgActionSlot('org-A', 'query');
    const res = await data('inquiries', 'list');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('query は記録しない（月間実行数を減らさない）', async () => {
    await data('inquiries', 'list');
    expect(fake.rows('pageActionLog')).toHaveLength(0);
  });

  it('認証なしは 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/pages/inquiries/data/list' })).statusCode).toBe(401);
  });
});

describe('POST /api/pages/:slug/actions/:actionId（submit）', () => {
  it('検証を通った入力だけを n8n に送り、PageActionLog を OK で確定（値は残さず項目名だけ）', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ ok: true, message: '登録しました', extra: 'drop' }));
    const requestId = randomUUID();
    const res = await submit('create', { input: FORM_INPUT, requestId, origin: { blockIndex: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true, message: '登録しました', sample: false });
    expect(calledUrls()).toEqual([`${N8N}/webhook/pages/org-A/inquiries-submit`]);
    expect(calledBody()).toMatchObject({ kind: 'submit', action: 'create', input: FORM_INPUT, requestId, orgId: 'org-A' });

    const rows = fake.rows('pageActionLog');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: 'org-A', pageId: 'p-pub', slug: 'inquiries', actionId: 'create', pageVersion: 1, actorId: 'u-member', requestId, status: 'OK',
    });
    expect(rows[0]!.inputKeys).toEqual(['name', 'tel', 'subject', 'body']);
    expect(typeof rows[0]!.durationMs).toBe('number');
    expect(JSON.stringify(rows)).not.toContain('山田');
  });

  it('ログに入力値も n8n の応答本文も出さない（T15）', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ unexpected: 'n8n-secret-body' }));
    const res = await submit('create');
    expect(res.statusCode).toBe(502);
    const all = logs.join('\n');
    expect(all).not.toContain('山田');
    expect(all).not.toContain('n8n-secret-body');
    expect(all).toContain('INVALID_RESPONSE');
  });

  it('ボタン（入力なし）と行の操作（rowId）', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
    expect((await submit('remind', { input: {}, requestId: randomUUID(), origin: { blockIndex: 3, itemIndex: 0 } })).statusCode).toBe(200);
    expect((await submit('done', { input: { rowId: 'q1' }, requestId: randomUUID(), origin: { blockIndex: 1 } })).statusCode).toBe(200);
    expect(calledBody(1).input).toEqual({ rowId: 'q1' });
  });

  it('n8n が { ok: false } なら 200 で文言を返し、記録は FAILED', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ ok: false, message: '重複しています' }));
    const res = await submit('create');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: false, message: '重複しています', sample: false });
    expect(fake.rows('pageActionLog')[0]!.status).toBe('FAILED');
  });

  it.each([
    ['定義に無い項目', { input: { ...FORM_INPUT, admin: true }, origin: { blockIndex: 2 } }],
    ['必須が空', { input: { ...FORM_INPUT, name: '' }, origin: { blockIndex: 2 } }],
    ['型違い', { input: { ...FORM_INPUT, tel: 123 }, origin: { blockIndex: 2 } }],
    ['送信元の部品が違う', { input: FORM_INPUT, origin: { blockIndex: 0 } }],
    ['ボタンに入力', { input: { x: 1 }, origin: { blockIndex: 3 } }],
    ['origin が無い', { input: FORM_INPUT }],
    ['requestId が UUID でない', { input: FORM_INPUT, origin: { blockIndex: 2 }, requestId: 'abc' }],
    ['body に余分なキー', { input: FORM_INPUT, origin: { blockIndex: 2 }, orgId: 'org-B' }],
  ] as Array<[string, Record<string, unknown>]>)('%s は 400 VALIDATION_ERROR で n8n に届かず、記録もしない', async (_n, body) => {
    const action = (body.origin as { blockIndex: number } | undefined)?.blockIndex === 3 ? 'remind' : 'create';
    const res = await submit(action, { requestId: randomUUID(), ...body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows('pageActionLog')).toHaveLength(0);
  });

  it('body の上限（96KB）を超えたら 413 PAYLOAD_TOO_LARGE（統一の形・日本語）で n8n に届かない', async () => {
    const res = await submit('create', { input: { ...FORM_INPUT, body: 'x'.repeat(97 * 1024) }, requestId: randomUUID(), origin: { blockIndex: 2 } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: '送信する内容が大きすぎます。入力を短くしてください。' },
    });
    expect(res.body).not.toContain('FST_ERR');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows('pageActionLog')).toHaveLength(0);
  });

  it('定義が許す最大の入力（日本語の textarea 2000 字 × 12 項目）は 413 にならず n8n に届く', async () => {
    const keyOf = (i: number) => `f${String(i).padStart(2, '0')}${'x'.repeat(29)}`;
    const fields = Array.from({ length: PAGE_DEFINITION_LIMITS.fieldsMax }, (_, i) => ({
      key: keyOf(i), label: `項目${i}`, type: 'textarea', maxLength: PAGE_DEFINITION_LIMITS.textareaMax,
    }));
    fake.rows('customPage').push(
      pageRow({
        id: 'p-big', orgId: 'org-A', slug: 'big-form',
        definition: { actions: { send: { kind: 'submit', hook: 'big' } }, blocks: [{ type: 'form', action: 'send', submit: '送信', fields }] },
      }),
    );
    fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
    const input = Object.fromEntries(fields.map((f) => [f.key, '漢'.repeat(PAGE_DEFINITION_LIMITS.textareaMax)]));
    const payload = { input, requestId: randomUUID(), origin: { blockIndex: 0 } };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(64 * 1024); // 32 文字の項目名 × 12。旧上限（16KB）では 413 だった
    const res = await submit('send', payload, MEMBER(), 'big-form');
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('手動 upsert（PUT /api/pages/:slug）の 64KB 超も 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/pages/orders', headers: ADMIN(),
      payload: { title: 'x', definition: { blocks: [], actions: {}, pad: 'x'.repeat(70 * 1024) } },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('413 以外のエラーは今までどおり（ハンドラは bodyLimit 超過だけを置き換える）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/pages/inquiries/actions/create', headers: { ...MEMBER(), 'content-type': 'application/json' }, payload: '{broken',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  it('確定（updateMany）が一時的に失敗しても、記録は PENDING のまま残さず FAILED で確定する（L2）', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
    // 偽 Prisma の pageActionLog.updateMany を 1 回だけ失敗させる
    const target = fake as unknown as { delegate: (m: string) => Record<string, (a?: unknown) => Promise<unknown>> };
    const original = target.delegate.bind(fake);
    let failed = false;
    target.delegate = (model: string) => {
      const d = original(model);
      if (model !== 'pageActionLog') return d;
      return {
        ...d,
        updateMany: async (args?: unknown) => {
          if (!failed) {
            failed = true;
            throw new Error('db temporarily unavailable');
          }
          return d.updateMany!(args);
        },
      };
    };
    const res = await submit('create');
    expect(res.statusCode).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fake.rows('pageActionLog')).toHaveLength(1);
    expect(fake.rows('pageActionLog')[0]!.status).toBe('FAILED');
  });

  it('同じ requestId は 409 DUPLICATE_REQUEST（n8n には 1 回だけ）', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
    const payload = { input: FORM_INPUT, requestId: randomUUID(), origin: { blockIndex: 2 } };
    expect((await submit('create', payload)).statusCode).toBe(200);
    const again = await submit('create', payload);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('DUPLICATE_REQUEST');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('当月の件数が上限（梅 300）なら 429 PAGE_ACTION_LIMIT。表示（query）は止めない', async () => {
    const now = new Date();
    for (let i = 0; i < 300; i++) {
      fake.rows('pageActionLog').push({
        id: `l${i}`, orgId: 'org-A', pageId: 'p-pub', slug: 'inquiries', actionId: 'create', pageVersion: 1, actorId: 'u-member',
        requestId: `r${i}`, status: 'OK', durationMs: 1, inputKeys: [], createdAt: now,
      });
    }
    const res = await submit('create');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('PAGE_ACTION_LIMIT');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await data('inquiries', 'list')).statusCode).toBe(200);
  });

  it('先月の件数は数えない', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
    const last = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 1000);
    for (let i = 0; i < 300; i++) {
      fake.rows('pageActionLog').push({
        id: `l${i}`, orgId: 'org-A', pageId: 'p-pub', slug: 'inquiries', actionId: 'create', pageVersion: 1, actorId: 'u-member',
        requestId: `r${i}`, status: 'OK', durationMs: 1, inputKeys: [], createdAt: last,
      });
    }
    expect((await submit('create')).statusCode).toBe(200);
  });

  it('他組織の件数は自分の上限に数えない', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ ok: true }));
    for (let i = 0; i < 300; i++) {
      fake.rows('pageActionLog').push({
        id: `b${i}`, orgId: 'org-B', pageId: 'p-B', slug: 'b-secret', actionId: 'create', pageVersion: 1, actorId: 'u-b',
        requestId: `r${i}`, status: 'OK', durationMs: 1, inputKeys: [], createdAt: new Date(),
      });
    }
    expect((await submit('create')).statusCode).toBe(200);
  });

  it('組織ごとに 1 分 30 回で 429 RATE_LIMITED', async () => {
    const { takeOrgActionSlot } = await import('../../src/services/pages/org-throttle');
    for (let i = 0; i < PAGE_ORG_THROTTLE.submit; i++) takeOrgActionSlot('org-A', 'submit');
    const res = await submit('create');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  it('n8n 未設定は 503 PAGE_NOT_CONNECTED。届いていないので数えない', async () => {
    delete process.env.N8N_URL;
    const res = await submit('create');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('PAGE_NOT_CONNECTED');
    expect(fake.rows('pageActionLog')).toHaveLength(0);
  });

  it.each([
    ['接続エラー', () => Promise.reject(new TypeError('fetch failed')), 502, 'PAGE_UPSTREAM_FAILED', 'FAILED'],
    ['500', async () => jsonRes({}, 500), 502, 'PAGE_UPSTREAM_FAILED', 'FAILED'],
    ['非 JSON', async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }), 502, 'PAGE_INVALID_RESPONSE', 'INVALID_RESPONSE'],
    ['ok が無い', async () => jsonRes({ message: 'x' }), 502, 'PAGE_INVALID_RESPONSE', 'INVALID_RESPONSE'],
  ])('%s は %s・記録は確定（submit はやり直さない）', async (_n, impl, status, code, logStatus) => {
    fetchMock.mockImplementation(impl);
    const res = await submit('create');
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fake.rows('pageActionLog')[0]!.status).toBe(logStatus);
  });

  it('query の action を submit で叩くと 404', async () => {
    expect((await submit('list')).statusCode).toBe(404);
  });

  it('他組織のページの action は 404 で、B に記録も残らない', async () => {
    const res = await submit('create', undefined, MEMBER(), 'b-secret');
    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows('pageActionLog')).toHaveLength(0);
  });
});

describe('サンプルモード（§8・T16）', () => {
  beforeEach(() => {
    process.env.PAGES_SAMPLE_MODE = 'true';
  });

  it('query は n8n を呼ばず sampleData を本番と同じ切り詰めに通す。connection は sample', async () => {
    const res = await data('inquiries', 'list');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.sample).toBe(true);
    expect(res.json().data.blocks[0].values).toEqual({ 0: 3, 1: 12 });
    expect(res.body).not.toContain('drop-me');
    expect(fetchMock).not.toHaveBeenCalled();
    const page = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: MEMBER() });
    expect(page.json().data.connection).toBe('sample');
  });

  it('n8n が未設定でもサンプルが優先', async () => {
    delete process.env.N8N_URL;
    expect((await data('inquiries', 'list')).statusCode).toBe(200);
  });

  it('submit は n8n を呼ばず、記録も数えもしない。入力の検証はする', async () => {
    const res = await submit('create');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true, message: 'サンプルのため送信していません', sample: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows('pageActionLog')).toHaveLength(0);
    expect((await submit('create', { input: { x: 1 }, requestId: randomUUID(), origin: { blockIndex: 2 } })).statusCode).toBe(400);
  });

  it('sampleData の無いページは通常どおり n8n へ', async () => {
    await data('draft-page', 'list', ADMIN());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('本番（NODE_ENV=production）では PAGES_SAMPLE_MODE=true でも n8n を呼ぶ', async () => {
    process.env.NODE_ENV = 'production';
    const res = await data('inquiries', 'list');
    expect(res.json().data.sample).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const page = await app.inject({ method: 'GET', url: '/api/pages/inquiries', headers: MEMBER() });
    expect(page.json().data.connection).toBe('ok');
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

  it('データ取得（GET）は通る。n8n には readOnly: true を渡す（LLM・外部送信をさせない合図。K50）', async () => {
    expect((await data('inquiries', 'list')).statusCode).toBe(200);
    expect(calledBody()).toMatchObject({ kind: 'query', readOnly: true });
  });

  it('送信（POST）は 402 SUBSCRIPTION_REQUIRED で n8n に届かない', async () => {
    const res = await submit('create');
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows('pageActionLog')).toHaveLength(0);
  });
});

describe('GET /api/pages/:slug の connection', () => {
  it('n8n 設定ありは ok、なしは not_configured', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/pages/heading', headers: MEMBER() })).json().data.connection).toBe('ok');
    delete process.env.N8N_URL;
    expect((await app.inject({ method: 'GET', url: '/api/pages/heading', headers: MEMBER() })).json().data.connection).toBe('not_configured');
  });

  it('オーナーも同じ定義の範囲（OWNER の role が n8n に渡る）', async () => {
    await data('owner-only', 'list', OWNER());
    expect(calledBody()).toMatchObject({ actor: { userId: 'u-owner', role: 'OWNER' } });
  });
});
