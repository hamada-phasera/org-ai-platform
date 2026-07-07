// 分析部署ルート (A-3) — usage-metrics-svc への認証付きプロキシ。
//
// usage-metrics-svc は認証を持たない社内サービスのため、本番では直接ブラウザへ
// 晒さず、このルート経由で公開する。tenant_id は必ず JWT の orgId から取る
// （クライアント指定は無視 = 他組織のメトリクスを覗けない）。
//
// 配線 (app.register) は統合フェーズ B が index.ts に追加する:
//   import { analyticsRoutes } from './routes/analytics';
//   await app.register(analyticsRoutes, { prefix: '/api/analytics' });
//
// 環境変数: METRICS_URL — usage-metrics-svc のベースURL（既定 http://localhost:8080）
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth';

const REQUEST_TIMEOUT_MS = 5_000;

function metricsBaseUrl(): string {
  return (process.env.METRICS_URL || 'http://localhost:8080').replace(/\/+$/, '');
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  // GET /departments?from=&to= → usage-metrics-svc GET /metrics/departments
  app.get('/departments', { preHandler: requireAuth }, async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const q = request.query as { from?: string; to?: string };

    const params = new URLSearchParams({ tenant_id: orgId });
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);

    try {
      const res = await fetch(`${metricsBaseUrl()}/metrics/departments?${params.toString()}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await res.json()) as unknown;
      // svc は既にプラットフォーム封筒 { success, data|error } を返すのでパススルー
      return reply.status(res.status).send(body);
    } catch {
      return reply.status(502).send({
        success: false,
        error: {
          code: 'METRICS_UNAVAILABLE',
          message: 'usage-metrics-svc に接続できません。サービスの起動状態と METRICS_URL を確認してください。',
        },
      });
    }
  });
}
