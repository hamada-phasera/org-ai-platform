import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// prisma は import 時に DATABASE_URL を要求するためモックする。
const prismaMock = {
  project: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  },
  costEntry: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  vendor: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
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
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
}));

const { accountingRoutes } = await import('../../src/routes/accounting');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(accountingRoutes, { prefix: '/api/accounting' });
  await app.ready();
  return app;
}

const PROJECT = {
  id: 'p-1',
  orgId: 'org-1',
  code: 'K-001',
  name: '〇〇邸新築',
  client: '山田建設',
  contractAmount: 10_000_000,
  startOn: new Date('2026-04-01T00:00:00Z'),
  dueOn: new Date('2026-12-20T00:00:00Z'),
  status: 'IN_PROGRESS',
  budgetMaterial: 3_000_000,
  budgetLabor: 2_000_000,
  budgetSubcon: 3_000_000,
  budgetOther: 500_000,
  progressRate: 40,
  note: null,
  createdAt: new Date('2026-04-01T00:00:00Z'),
  updatedAt: new Date('2026-04-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.project.groupBy.mockResolvedValue([]);
  prismaMock.project.count.mockResolvedValue(0);
  prismaMock.costEntry.groupBy.mockResolvedValue([]);
  prismaMock.costEntry.count.mockResolvedValue(0);
});

describe('GET /api/accounting/projects', () => {
  it('正常系: 工事ごとに粗利と予算消化を添えて返す', async () => {
    prismaMock.project.findMany.mockResolvedValue([PROJECT]);
    prismaMock.costEntry.groupBy.mockResolvedValue([
      { projectId: 'p-1', category: 'MATERIAL', _sum: { amount: 2_000_000 } },
      { projectId: 'p-1', category: 'SUBCON', _sum: { amount: 3_500_000 } },
    ]);

    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounting/projects' });

    expect(res.statusCode).toBe(200);
    const [row] = res.json().data;
    expect(row.actualTotal).toBe(5_500_000);
    expect(row.grossProfit).toBe(4_500_000);
    expect(row.grossMarginRate).toBe(45);
    expect(row.overBudget).toEqual(['SUBCON']); // 外注費が予算300万を超えている
    expect(row.startOn).toBe('2026-04-01'); // 日付は時刻を持たせない
  });

  it('⚠️ 既定は確定分だけを積む（承認しても数字が動かない、を作らない）', async () => {
    // 画面は「確定したものだけが工事台帳の数字になります」と言っている。
    // 既定が DRAFT 込みだと、承認操作が1円も数字を動かさず無意味に見える
    prismaMock.project.findMany.mockResolvedValue([PROJECT]);
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/accounting/projects' });
    expect(prismaMock.costEntry.groupBy.mock.calls[0][0].where.status).toBe('CONFIRMED');
  });

  it('includeDraft=true で未確認込みにできる', async () => {
    prismaMock.project.findMany.mockResolvedValue([PROJECT]);
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/accounting/projects?includeDraft=true' });
    expect(prismaMock.costEntry.groupBy.mock.calls[0][0].where.status).toBeUndefined();
  });

  it('金額が INTEGER の上限を超えたら 400（500 にしない）', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/projects',
      payload: { code: 'K-BIG', name: '巨大工事', contractAmount: 3_000_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.project.create).not.toHaveBeenCalled();
  });

  it('必ず orgId で絞る（他社の工事が混ざらない）', async () => {
    prismaMock.project.findMany.mockResolvedValue([]);
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/accounting/projects' });
    expect(prismaMock.project.findMany.mock.calls[0][0].where.orgId).toBe('org-1');
  });

  it('エッジ: 不正なステータスは 400', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounting/projects?status=BOGUS' });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.project.findMany).not.toHaveBeenCalled();
  });

  it('原価が1件も無い工事でも落ちない（粗利＝請負金額）', async () => {
    prismaMock.project.findMany.mockResolvedValue([PROJECT]);
    prismaMock.costEntry.groupBy.mockResolvedValue([]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounting/projects' });
    expect(res.json().data[0].grossProfit).toBe(10_000_000);
  });
});

describe('POST /api/accounting/projects', () => {
  it('正常系: 作成する', async () => {
    prismaMock.project.create.mockResolvedValue(PROJECT);
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/projects',
      payload: { code: 'K-001', name: '〇〇邸新築', contractAmount: 10_000_000, startOn: '2026-04-01' },
    });
    expect(res.statusCode).toBe(201);
    const data = prismaMock.project.create.mock.calls[0][0].data;
    expect(data.orgId).toBe('org-1');
    expect(data.startOn).toBeInstanceOf(Date);
    expect(data.startOn.toISOString()).toBe('2026-04-01T00:00:00.000Z'); // UTC 深夜（JST で日がずれない）
  });

  it('工事番号の重複は 409（500 にしない）', async () => {
    prismaMock.project.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/projects',
      payload: { code: 'K-001', name: 'かぶり' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('K-001');
  });

  it('エッジ: 存在しない日付（2026-02-31）は 400 で、DB に行かない', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/projects',
      payload: { code: 'K-002', name: 'テスト', startOn: '2026-02-31' },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.project.create).not.toHaveBeenCalled();
  });

  it('エッジ: 負の請負金額は 400', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/projects',
      payload: { code: 'K-003', name: 'テスト', contractAmount: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/accounting/projects/:id', () => {
  it('他 org の工事は id を知っていても 404（更新しない）', async () => {
    prismaMock.project.findFirst.mockResolvedValue(null);
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/accounting/projects/p-other',
      payload: { name: '乗っ取り' },
    });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.project.update).not.toHaveBeenCalled();
    // 存在確認そのものが orgId 込みで行われている
    expect(prismaMock.project.findFirst.mock.calls[0][0].where.orgId).toBe('org-1');
  });
});

describe('DELETE /api/accounting/projects/:id', () => {
  it('原価明細が残っている工事は 409 で消さない（CASCADE で履歴が消えるため）', async () => {
    prismaMock.project.findFirst.mockResolvedValue(PROJECT);
    prismaMock.costEntry.count.mockResolvedValue(12);
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/accounting/projects/p-1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('12');
    expect(prismaMock.project.delete).not.toHaveBeenCalled();
  });

  it('明細が無ければ消せる', async () => {
    prismaMock.project.findFirst.mockResolvedValue(PROJECT);
    prismaMock.costEntry.count.mockResolvedValue(0);
    prismaMock.project.delete.mockResolvedValue(PROJECT);
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/accounting/projects/p-1' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/accounting/costs', () => {
  const created = {
    id: 'c-1',
    orgId: 'org-1',
    projectId: 'p-1',
    vendorId: null,
    incurredOn: new Date('2026-09-05T00:00:00Z'),
    category: 'MATERIAL',
    amount: 31_818,
    taxAmount: 3_182,
    description: '木材',
    source: 'LINE',
    status: 'DRAFT',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('税込で受けたら本体価格と消費税に分けて保存する（領収書経路）', async () => {
    prismaMock.project.findFirst.mockResolvedValue({ id: 'p-1' });
    prismaMock.costEntry.create.mockResolvedValue(created);
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/costs',
      payload: {
        projectId: 'p-1',
        incurredOn: '2026-09-05',
        category: 'MATERIAL',
        amountIncludingTax: 35_000,
        source: 'LINE',
      },
    });
    expect(res.statusCode).toBe(201);
    const data = prismaMock.costEntry.create.mock.calls[0][0].data;
    expect(data.amount).toBe(31_818);
    expect(data.taxAmount).toBe(3_182);
    expect(data.amount + data.taxAmount).toBe(35_000); // 合計は必ず元に戻る
  });

  it('AI 由来の明細は既定で DRAFT（読み取っただけで確定させない）', async () => {
    prismaMock.project.findFirst.mockResolvedValue({ id: 'p-1' });
    prismaMock.costEntry.create.mockResolvedValue(created);
    const app = await build();
    await app.inject({
      method: 'POST',
      url: '/api/accounting/costs',
      payload: { projectId: 'p-1', incurredOn: '2026-09-05', category: 'LABOR', amount: 50_000 },
    });
    expect(prismaMock.costEntry.create.mock.calls[0][0].data.status).toBe('DRAFT');
  });

  it('他 org の工事に紐付けようとしたら 404（作成しない）', async () => {
    prismaMock.project.findFirst.mockResolvedValue(null);
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/costs',
      payload: { projectId: 'p-other', incurredOn: '2026-09-05', category: 'MATERIAL', amount: 1_000 },
    });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.costEntry.create).not.toHaveBeenCalled();
  });

  it('他 org の取引先に紐付けようとしたら 404（作成しない）', async () => {
    prismaMock.project.findFirst.mockResolvedValue({ id: 'p-1' });
    prismaMock.vendor.findFirst.mockResolvedValue(null);
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/costs',
      payload: {
        projectId: 'p-1',
        vendorId: 'v-other',
        incurredOn: '2026-09-05',
        category: 'SUBCON',
        amount: 1_000,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(prismaMock.costEntry.create).not.toHaveBeenCalled();
  });

  it('エッジ: 金額を一切指定しなければ 400', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/costs',
      payload: { projectId: 'p-1', incurredOn: '2026-09-05', category: 'MATERIAL' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('エッジ: 未知の費目は 400（勝手に OTHER に寄せない）', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/costs',
      payload: { projectId: 'p-1', incurredOn: '2026-09-05', category: 'WELFARE', amount: 100 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/accounting/costs/confirm', () => {
  it('DRAFT だけを、自 org の分だけ確定する', async () => {
    prismaMock.costEntry.updateMany.mockResolvedValue({ count: 2 });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/costs/confirm',
      payload: { ids: ['c-1', 'c-2', 'c-other'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.confirmed).toBe(2);
    const where = prismaMock.costEntry.updateMany.mock.calls[0][0].where;
    expect(where.orgId).toBe('org-1');
    expect(where.status).toBe('DRAFT'); // 確定済みを再確定しない
  });

  it('エッジ: 空配列は 400', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/costs/confirm',
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.costEntry.updateMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/accounting/vendors/invoice-impact', () => {
  it('未登録先に払っている消費税から負担増を出す', async () => {
    prismaMock.vendor.findMany.mockResolvedValue([
      { id: 'v-1', name: '一人親方A', kind: 'SOLO' },
      { id: 'v-2', name: '下請B', kind: 'SUBCON' },
    ]);
    prismaMock.costEntry.groupBy.mockResolvedValue([
      { vendorId: 'v-1', _sum: { amount: 600_000, taxAmount: 60_000 } },
      { vendorId: 'v-2', _sum: { amount: 400_000, taxAmount: 40_000 } },
    ]);
    prismaMock.costEntry.count.mockResolvedValue(3);

    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounting/vendors/invoice-impact' });

    expect(res.statusCode).toBe(200);
    const { impact, unregisteredVendors, unlinkedCostEntryCount } = res.json().data;
    expect(impact.unregisteredTax).toBe(100_000);
    expect(unregisteredVendors[0].name).toBe('一人親方A'); // 税額の大きい順
    expect(unlinkedCostEntryCount).toBe(3);
    // 未登録の取引先だけを対象にしている
    expect(prismaMock.vendor.findMany.mock.calls[0][0].where.invoiceRegistered).toBe(false);
  });

  it('未登録先がいなければ余計なクエリを投げずに 0 を返す', async () => {
    prismaMock.vendor.findMany.mockResolvedValue([]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounting/vendors/invoice-impact' });
    expect(res.json().data.impact.additionalBurden).toBe(0);
    expect(prismaMock.costEntry.groupBy).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounting/vendors', () => {
  it('登録番号の形式を検証する（T + 数字13桁）', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/vendors',
      payload: { name: '下請C', invoiceNumber: 'T123' },
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.vendor.create).not.toHaveBeenCalled();
  });

  it('正しい登録番号なら作成する', async () => {
    prismaMock.vendor.create.mockResolvedValue({ id: 'v-3', name: '下請C' });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounting/vendors',
      payload: { name: '下請C', invoiceNumber: 'T1234567890123', invoiceRegistered: true },
    });
    expect(res.statusCode).toBe(201);
    expect(prismaMock.vendor.create.mock.calls[0][0].data.orgId).toBe('org-1');
  });
});

describe('GET /api/accounting/summary', () => {
  it('未成工事支出金も今月の原価も確定分だけを積む', async () => {
    prismaMock.project.groupBy.mockResolvedValue([{ status: 'IN_PROGRESS', _count: { _all: 2 } }]);
    prismaMock.project.count.mockResolvedValue(2);
    prismaMock.costEntry.count.mockResolvedValue(5);
    prismaMock.costEntry.groupBy
      .mockResolvedValueOnce([{ category: 'MATERIAL', _sum: { amount: 100_000 } }]) // 今月
      .mockResolvedValueOnce([{ category: 'SUBCON', _sum: { amount: 900_000 } }]); // 未成工事

    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounting/summary?month=2026-09' });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.monthlyCost.total).toBe(100_000);
    expect(data.workInProgress.total).toBe(900_000);
    expect(data.workInProgress.projectCount).toBe(2);
    expect(data.pendingCostEntries).toBe(5);
    // ⚠️ 同じ画面の中で確定分と DRAFT 込みが混在すると、どの数字が何なのか読めない
    expect(prismaMock.costEntry.groupBy.mock.calls[0][0].where.status).toBe('CONFIRMED');
    expect(prismaMock.costEntry.groupBy.mock.calls[1][0].where.status).toBe('CONFIRMED');
    // 未成工事はリレーションフィルタで DB 側に絞らせる（工事 id を全件 IN に入れない）
    expect(prismaMock.costEntry.groupBy.mock.calls[1][0].where.project.status.in).toContain('IN_PROGRESS');
  });

  it('月の範囲は UTC の月初から翌月初まで（JST でも境界がずれない）', async () => {
    prismaMock.project.findMany.mockResolvedValue([]);
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/accounting/summary?month=2026-12' });
    const range = prismaMock.costEntry.groupBy.mock.calls[0][0].where.incurredOn;
    expect(range.gte.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(range.lt.toISOString()).toBe('2027-01-01T00:00:00.000Z'); // 年またぎ
  });

  it('エッジ: 不正な month は 400', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/accounting/summary?month=2026-13' });
    expect(res.statusCode).toBe(400);
  });
});
