import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { authRoutes } from './routes/auth';
import { chatRoutes } from './routes/chat';
import { governanceRoutes } from './routes/governance';
import { fileRoutes } from './routes/files';
import { taskRoutes } from './routes/tasks';
import { webhookRoutes } from './routes/webhooks';
import { agentRoutes } from './routes/agents';
import { llmRoutes } from './routes/llm';
import { organizationRoutes } from './routes/organizations';
import { scheduledTaskRoutes } from './routes/scheduled-tasks';
import { capabilityRoutes } from './routes/capabilities';
import { prisma } from './utils/prisma';

const app = Fastify({ logger: true });

async function start(): Promise<void> {
  // 明示許可リスト (FRONTEND_URL, カンマ区切り) + localhost + 任意の *.vercel.app を許可。
  // Vercel のプレビュー URL はデプロイ毎に変わるため、env だけの完全一致では運用に耐えない。
  const explicitOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*');
  await app.register(cors, {
    origin: (origin, cb) => {
      // 同一オリジン / 非ブラウザ (origin 無し) は許可
      if (!origin) return cb(null, true);
      let host = '';
      try {
        host = new URL(origin).hostname;
      } catch {
        return cb(null, false);
      }
      const ok =
        explicitOrigins.includes(origin) ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.endsWith('.vercel.app');
      cb(null, ok);
    },
    credentials: true,
  });

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is required and must be at least 32 characters. Set it in your environment.');
  }
  await app.register(jwt, { secret: jwtSecret });

  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB
  await app.register(websocket);

  app.get('/health', async () => ({
    status: 'ok',
    service: 'api-gateway',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'connected', timestamp: new Date().toISOString() };
    } catch (e) {
      return reply.code(503).send({
        status: 'error',
        db: 'disconnected',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(chatRoutes, { prefix: '/api/chat' });
  await app.register(governanceRoutes, { prefix: '/api/governance' });
  await app.register(fileRoutes, { prefix: '/api/files' });
  await app.register(taskRoutes, { prefix: '/api/tasks' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });
  await app.register(agentRoutes, { prefix: '/api/agents' });
  await app.register(llmRoutes, { prefix: '/api/llm' });
  await app.register(organizationRoutes, { prefix: '/api/organizations' });
  await app.register(scheduledTaskRoutes, { prefix: '/api/scheduled-tasks' });
  await app.register(capabilityRoutes, { prefix: '/api/capabilities' });

  const port = parseInt(process.env.PORT ?? '4000');
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API Gateway running on port ${port}`);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
