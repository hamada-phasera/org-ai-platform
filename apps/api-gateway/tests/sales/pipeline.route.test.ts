import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// prisma は import 時に DATABASE_URL を要求するためモックする。
// インメモリ実装を Prisma Deal に正式化したため、Deal CRUD をインメモリ配列で模擬する。
interface FakeDeal {
  id: string;
  orgId: string;
  title: string;
  company: string | null;
  amount: number;
  stage: string;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
let store: FakeDeal[] = [];
let seq = 0;

const prismaMock = {
  deal: {
    findMany: vi.fn(async ({ where }: { where: { orgId: string; stage?: string } }) =>
      store.filter((d) => d.orgId === where.orgId && (where.stage === undefined || d.stage === where.stage)),
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.find((d) => d.id === where.id) ?? null),
    create: vi.fn(async ({ data }: { data: Omit<FakeDeal, 'id' | 'createdAt' | 'updatedAt'> }) => {
      const deal: FakeDeal = { ...data, id: `deal-${++seq}`, createdAt: new Date(), updatedAt: new Date() };
      store.push(deal);
      return deal;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeDeal> }) => {
      const deal = store.find((d) => d.id === where.id);
      if (!deal) throw new Error('not found');
      Object.assign(deal, data, { updatedAt: new Date() });
      return deal;
    }),
  },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

// 認証ミドルウェアをモックし、request.user を注入する（JWT を発行せずに済む）。
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireOwner: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
}));

const { salesPipelineRoutes } = await import('../../src/routes/sales/pipeline');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(salesPipelineRoutes, { prefix: '/api/sales/pipeline' });
  await app.ready();
  return app;
}

beforeEach(() => {
  store = [];
  seq = 0;
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

  it('エッジ: 他 org の商談は見えない（orgId スコープ）', async () => {
    store.push({
      id: 'deal-other',
      orgId: 'org-2',
      title: '他社の商談',
      company: null,
      amount: 0,
      stage: 'LEAD',
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/sales/pipeline' });
    expect(res.json().data).toHaveLength(0);

    const detail = await app.inject({ method: 'GET', url: '/api/sales/pipeline/deal-other' });
    expect(detail.statusCode).toBe(404);
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
