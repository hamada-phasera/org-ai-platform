import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// 認証ミドルウェアをモックし、request.user を注入する（JWT を発行せずに済む）。
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireOwner: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
}));

const { salesPipelineRoutes, _resetPipelineStore } = await import('../../src/routes/sales/pipeline');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(salesPipelineRoutes, { prefix: '/api/sales/pipeline' });
  await app.ready();
  return app;
}

beforeEach(() => {
  _resetPipelineStore();
  vi.clearAllMocks();
});

describe('POST /api/sales/pipeline', () => {
  it('正常系: 商談を作成し 201 + 既定ステージ LEAD を返す', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/pipeline',
      payload: { title: '株式会社Acme 新規商談', company: 'Acme', amount: 500000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.stage).toBe('LEAD');
    expect(body.data.title).toBe('株式会社Acme 新規商談');
    expect(body.data.orgId).toBe('org-1');
    expect(typeof body.data.id).toBe('string');
    await app.close();
  });

  it('エッジ: title 空 → 400 VALIDATION_ERROR', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sales/pipeline',
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });
});

describe('GET /api/sales/pipeline', () => {
  it('正常系: 作成した商談を一覧で返す（?stage= 絞り込みも効く）', async () => {
    const app = await build();
    await app.inject({ method: 'POST', url: '/api/sales/pipeline', payload: { title: 'A' } });
    await app.inject({
      method: 'POST',
      url: '/api/sales/pipeline',
      payload: { title: 'B', stage: 'PROPOSAL' },
    });

    const all = await app.inject({ method: 'GET', url: '/api/sales/pipeline' });
    expect(all.statusCode).toBe(200);
    expect(all.json().data).toHaveLength(2);

    const proposals = await app.inject({ method: 'GET', url: '/api/sales/pipeline?stage=PROPOSAL' });
    expect(proposals.json().data).toHaveLength(1);
    expect(proposals.json().data[0].title).toBe('B');
    await app.close();
  });

  it('エッジ: 不正な stage クエリ → 400 VALIDATION_ERROR', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/sales/pipeline?stage=LOST' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    await app.close();
  });
});

describe('PATCH /api/sales/pipeline/:dealId', () => {
  async function createDeal(app: FastifyInstance, payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/sales/pipeline', payload });
    return res.json().data.id as string;
  }

  it('正常系: ステージを LEAD → NEGOTIATION に更新する', async () => {
    const app = await build();
    const id = await createDeal(app, { title: '商談X' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sales/pipeline/${id}`,
      payload: { stage: 'NEGOTIATION' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.stage).toBe('NEGOTIATION');
    await app.close();
  });

  it('エッジ: 受注(WON)からの差し戻し → 409 INVALID_TRANSITION', async () => {
    const app = await build();
    const id = await createDeal(app, { title: '受注済み', stage: 'WON' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sales/pipeline/${id}`,
      payload: { stage: 'LEAD' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
    await app.close();
  });

  it('エッジ: 存在しない商談ID → 404 NOT_FOUND', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sales/pipeline/does-not-exist',
      payload: { stage: 'NEGOTIATION' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
