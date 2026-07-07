import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.METRICS_URL = 'https://metrics.test';

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireOwner: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { analyticsRoutes } = await import('../../src/routes/analytics');

const SAMPLE_REPORT = {
  success: true,
  data: {
    tenantId: 'org-1',
    from: '2026-06-07T00:00:00Z',
    to: '2026-07-07T00:00:00Z',
    departments: [
      { department: 'SALES', calls: 4, tokens: 3_000_000, costUsd: 9.0, avgLatencyMs: 500, p95LatencyMs: 900 },
      { department: 'MARKETING', calls: 2, tokens: 1_000_000, costUsd: 9.0, avgLatencyMs: 1500, p95LatencyMs: 2000 },
    ],
  },
};

function metricsOk(body: unknown = SAMPLE_REPORT, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/analytics/departments (A-3 プロキシ)', () => {
  it('正常系: svc の封筒をパススルーし、tenant_id は JWT の orgId を使う', async () => {
    fetchMock.mockResolvedValue(metricsOk());
    const app = await build();

    const res = await app.inject({ method: 'GET', url: '/api/analytics/departments' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.departments).toHaveLength(2);
    expect(body.data.departments[0].department).toBe('SALES');

    // 呼び出しURL検証: tenant_id=JWTのorgId
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('https://metrics.test/metrics/departments?');
    expect(calledUrl).toContain('tenant_id=org-1');
  });

  it('正常系: from/to クエリを svc へ転送する', async () => {
    fetchMock.mockResolvedValue(metricsOk());
    const app = await build();

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/departments?from=2026-06-01&to=2026-07-01',
    });

    expect(res.statusCode).toBe(200);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('from=2026-06-01');
    expect(calledUrl).toContain('to=2026-07-01');
  });

  it('エッジ: クライアントが tenant_id を指定しても JWT の orgId で上書き（覗き見不可）', async () => {
    fetchMock.mockResolvedValue(metricsOk());
    const app = await build();

    await app.inject({ method: 'GET', url: '/api/analytics/departments?tenant_id=other-org' });

    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('tenant_id=org-1');
    expect(calledUrl).not.toContain('other-org');
  });

  it('エッジ: svc のエラー封筒 (400) はステータスごとパススルー', async () => {
    fetchMock.mockResolvedValue(
      metricsOk({ success: false, error: { code: 'INVALID_RANGE', message: 'to must be after from' } }, 400),
    );
    const app = await build();

    const res = await app.inject({
      method: 'GET',
      url: '/api/analytics/departments?from=2026-07-02&to=2026-07-01',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_RANGE');
  });

  it('エッジ: svc 停止（fetch失敗）は 502 METRICS_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = await build();

    const res = await app.inject({ method: 'GET', url: '/api/analytics/departments' });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('METRICS_UNAVAILABLE');
  });
});
