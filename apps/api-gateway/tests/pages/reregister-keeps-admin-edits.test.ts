import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FakePrisma } from '../helpers/fake-prisma';
import { orgRow, userAndMembership } from './fixtures';

// 再登録で管理者の値を戻さない（docs/design/custom-pages.md §5.3・K51。レビュー M2）。
// 「n8n のサンプルで登録 → 設定画面で公開・タイトル・アイコンを変える → サンプルの body をそのまま再登録」を
// 実際のルート（/api/webhooks/n8n/pages と /api/pages）越しに通す。body は n8n サンプルの JSON から読む（写して使われるので）。

let fake: FakePrisma;
vi.mock('../../src/utils/prisma', () => ({
  get prisma() {
    return fake;
  },
}));

const { registerTenantContext } = await import('../../src/tenancy/context');
const { clearMembershipCache } = await import('../../src/tenancy/membership-cache');
const { pageRoutes } = await import('../../src/routes/pages');
const { n8nPageRoutes } = await import('../../src/routes/n8n-pages');
const { hashPageToken } = await import('../../src/services/pages/page-token');

const SECRET = 'reregister-test-secret-32-chars-long!!!';
const TOKEN = `flowpg_${'a'.repeat(43)}`;
const ROOT = join(__dirname, '..', '..', '..', '..');

/** n8n サンプル（apps/n8n-workflows/pages/page-inquiries.json）の「ページを登録」ノードの body */
function sampleRegisterBody(): Record<string, unknown> {
  const wf = JSON.parse(readFileSync(join(ROOT, 'apps', 'n8n-workflows', 'pages', 'page-inquiries.json'), 'utf8')) as {
    nodes: { type: string; parameters: Record<string, unknown> }[];
  };
  const put = wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest');
  return JSON.parse(String(put?.parameters.jsonBody)) as Record<string, unknown>;
}

let app: FastifyInstance;
async function build(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(jwt, { secret: SECRET });
  registerTenantContext(a);
  await a.register(pageRoutes, { prefix: '/api/pages' });
  await a.register(n8nPageRoutes, { prefix: '/api/webhooks/n8n/pages' });
  await a.ready();
  return a;
}

beforeEach(async () => {
  const owner = userAndMembership('u-owner', 'org-A', 'OWNER');
  fake = new FakePrisma({
    organization: [orgRow('org-A')],
    user: [owner.user],
    membership: [owner.membership],
    customPage: [],
    pageToken: [
      { id: 'tok-A', orgId: 'org-A', label: 'n8n', tokenHash: hashPageToken(TOKEN), prefix: TOKEN.slice(0, 10), lastUsedAt: null, revokedAt: null, createdBy: 'u-owner', createdAt: new Date() },
    ],
    pageActionLog: [],
    auditEvent: [],
  });
  clearMembershipCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (!app) app = await build();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const register = (body: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/api/webhooks/n8n/pages/inquiries', headers: { 'x-page-token': TOKEN }, payload: body });
const patch = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: '/api/pages/inquiries',
    headers: { authorization: `Bearer ${app.jwt.sign({ sub: 'u-owner', orgId: 'org-A', role: 'OWNER' })}` },
    payload,
  });
const row = () => fake.rows('customPage').find((p) => p.slug === 'inquiries')!;

describe('n8n の再登録で管理者が画面で変えた値を戻さない', () => {
  it('公開 → サンプルの body をそのまま再登録しても PUBLISHED のまま', async () => {
    expect((await register(sampleRegisterBody())).statusCode).toBe(201);
    expect(row().status).toBe('DRAFT');
    expect((await patch({ status: 'PUBLISHED' })).statusCode).toBe(200);

    const again = await register(sampleRegisterBody());
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toMatchObject({ status: 'PUBLISHED', changed: false });
    expect(row().status).toBe('PUBLISHED');
  });

  it('画面で変えたタイトル・アイコンは、再登録でも定義を変えた再登録でも保つ', async () => {
    await register(sampleRegisterBody());
    expect((await patch({ title: '受付', icon: 'file-text' })).statusCode).toBe(200);
    expect(row().adminEditedFields).toEqual(['title', 'icon']);

    await register(sampleRegisterBody());
    expect(row()).toMatchObject({ title: '受付', icon: 'file-text', version: 1 });

    // 定義を変えた再登録（version は上がる）でも、タイトルとアイコンは管理者の値
    const changed = sampleRegisterBody();
    const def = changed.definition as { blocks: unknown[] };
    def.blocks = [{ type: 'heading', text: '受付の一覧' }, ...def.blocks];
    const res = await register(changed);
    expect(res.json().data).toMatchObject({ changed: true, version: 2 });
    expect(row()).toMatchObject({ title: '受付', icon: 'file-text', version: 2 });
  });

  it('管理者が触っていない項目は n8n の値で更新される（タイトルだけ変えたらアイコンは n8n のまま）', async () => {
    await register(sampleRegisterBody());
    await patch({ title: '受付' });
    expect(row().adminEditedFields).toEqual(['title']);

    const res = await register({ ...sampleRegisterBody(), title: '問い合わせ一覧', icon: 'clipboard-list' });
    expect(res.statusCode).toBe(200);
    expect(row()).toMatchObject({ title: '受付', icon: 'clipboard-list' });
  });

  it('公開・並びだけの PATCH は記録しない（status / sortOrder は body に書かれたときだけ上書きの決まりで守る）', async () => {
    await register(sampleRegisterBody());
    await patch({ status: 'PUBLISHED', sortOrder: 3 });
    expect(row().adminEditedFields).toEqual([]);
  });
});
