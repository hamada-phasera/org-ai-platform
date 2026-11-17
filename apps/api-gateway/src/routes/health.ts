// 死活監視（/health）と準備完了（/ready）。認証なし・レート制限なし（/health）。
//
// ⚠️ /ready の 503 には例外の文言を返さない（接続先のホスト名やユーザー名が出ることがある）。
//    詳細はログにだけ出す。
// DB への問い合わせは呼び出し側（index.ts）が渡す。ルートから素の prisma を import しないため。

import type { FastifyInstance } from 'fastify';
import { createLogger, errorMessage } from '../utils/logger';

const log = createLogger('ready');

export interface HealthRouteOptions {
  /** DB に 1 回問い合わせる。失敗したら例外 */
  pingDb: () => Promise<unknown>;
}

export async function healthRoutes(app: FastifyInstance, opts: HealthRouteOptions): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'api-gateway',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      await opts.pingDb();
      return { status: 'ok', db: 'connected', timestamp: new Date().toISOString() };
    } catch (e) {
      log.error('DB に接続できません', errorMessage(e));
      return reply.code(503).send({ status: 'error', db: 'disconnected' });
    }
  });
}
