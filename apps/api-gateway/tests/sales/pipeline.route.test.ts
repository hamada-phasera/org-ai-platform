import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// 商談は Prisma の Deal モデルに永続化するようになったため、prisma をモックする。
// テストの振る舞い（作成→一覧→絞り込み→遷移）を保つため、配列を裏に持つステートフルな
// インメモリ実装で deal.create/findMany/findUnique/update を再現する（sns tests と同じ vi.mock 方式）。
interface DealRow {
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
const store: DealRow[] = [];

const prismaMock = {
  deal: {
    create: vi.fn(async ({ data }: { data: Partial<DealRow> }) => {
      const now = new Date();
      const row: DealRow = {
        id: randomUUID(),
        orgId: data.orgId as string,
        title: data.title as string,
        company: data.company ?? null,
        amount: data.amount ?? 0,
        stage: data.stage ?? 'LEAD',
        ownerId: data.ownerId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      store.push(row);
      return row;
    }),
    findMany: vi.fn(async ({ where }: { where: { orgId: string; stage?: string } }) =>
      store.filter((d) => d.orgId === where.orgId && (where.stage === undefined || d.stage === where.stage)),
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.find((d) => d.id === where.id) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DealRow> }) => {
      const row = store.find((d) => d.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }),
  },
};
vi.mock('../../src/utils/prisma', () => ({ prisma: prismaMock }));

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
  store.length = 0;
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
    expect(body.data.ownerId).toBe('user-1');
    expect(typeof body.data.id).toBe('string');
    // 永続化（prisma.deal.create）が呼ばれる
    expect(prismaMock.deal.create).toHaveBeenCalledTimes(1);
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
    expect(prismaMock.deal.create).not.toHaveBeenCalled();
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
    // 絞り込みは prisma の where.stage で行う（クライアント側フィルタではない）
    const lastFindMany = prismaMock.deal.findMany.mock.calls.at(-1)?.[0];
    expect(lastFindMany?.where).toMatchObject({ orgId: 'org-1', stage: 'PROPOSAL' });
    await app.close();
  });

  it('エッジ: 不正な stage クエリ → 400 VALIDATION_ERROR', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/sales/pipeline?stage=LOST' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(prismaMock.deal.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('テナント分離: 他 org の商談は返さない', async () => {
    const app = await build();
    await app.inject({ method: 'POST', url: '/api/sales/pipeline', payload: { title: '自org' } });
    // 別 org の行を直接投入
    store.push({
      id: randomUUID(),
      orgId: 'org-2',
      title: '他org',
      company: null,
      amount: 0,
      stage: 'LEAD',
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const all = await app.inject({ method: 'GET', url: '/api/sales/pipeline' });
    expect(all.json().data).toHaveLength(1);
    expect(all.json().data[0].title).toBe('自org');
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
    // 遷移不可なら update は呼ばれない
    expect(prismaMock.deal.update).not.toHaveBeenCalled();
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

  it('テナント分離: 他 org の商談は更新できない（404）', async () => {
    const app = await build();
    const otherId = randomUUID();
    store.push({
      id: otherId,
      orgId: 'org-2',
      title: '他org',
      company: null,
      amount: 0,
      stage: 'LEAD',
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sales/pipeline/${otherId}`,
      payload: { stage: 'NEGOTIATION' },
    });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.deal.update).not.toHaveBeenCalled();
    await app.close();
  });
});
