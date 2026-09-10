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
import { dashboardRoutes } from './routes/dashboard';
import { deliverablesRoutes } from './routes/deliverables';
import { salesPipelineRoutes } from './routes/sales/pipeline';
import { salesProposalsRoutes } from './routes/sales/proposals';
import { snsPostsRoutes } from './routes/sns/posts';
import { analyticsRoutes } from './routes/analytics';
import { lineWebhookRoutes } from './routes/inbox/line-webhook';
import { inboxMessagesRoutes } from './routes/inbox/messages';
import { inboxConnectionsRoutes } from './routes/inbox/connections';
import { integrationsRoutes } from './routes/integrations';
import { oauthGoogleRoutes } from './routes/oauth-google';
import { accountingRoutes } from './routes/accounting';
import { memberRoutes } from './routes/members';
import { installShutdownHandlers } from './services/lifecycle';
import { startInternalScheduler } from './services/schedule-dispatcher';
import { recoverStaleRunningTasks } from './services/step-runner';
import { prisma } from './utils/prisma';

const app = Fastify({ logger: true });

async function start(): Promise<void> {
  // 明示許可リスト (FRONTEND_URL, カンマ区切り) + localhost + 自分のフロントのみ許可。
  // 以前は *.vercel.app 全許可 + credentials:true で、任意の Vercel ユーザーのサイトから
  // 資格情報付きリクエストが可能だった（本番検証時の指摘）。
  //
  // Vercel のホスト名は 3 種類あるので取りこぼすとフロントが全滅する:
  //   - 本番エイリアス: org-ai-platform.vercel.app（実際に公開されているのはこれ）
  //   - プロジェクトエイリアス: flow-hamahiro1668s-projects.vercel.app
  //   - デプロイ毎: flow-<hash>-hamahiro1668s-projects.vercel.app（毎回変わる）
  // 末尾のアカウント固有サフィックスは他人が取得できないため、これだけワイルドカードにする。
  const explicitOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*');
  const extraHosts = (process.env.ALLOWED_ORIGIN_HOSTS ?? 'org-ai-platform.vercel.app')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const vercelSuffix = process.env.VERCEL_PREVIEW_SUFFIX ?? '-hamahiro1668s-projects.vercel.app';
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
        extraHosts.includes(host) ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.endsWith(vercelSuffix);
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
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  await app.register(deliverablesRoutes, { prefix: '/api/deliverables' });
  await app.register(salesPipelineRoutes, { prefix: '/api/sales/pipeline' });
  await app.register(salesProposalsRoutes, { prefix: '/api/sales/proposals' });
  await app.register(snsPostsRoutes, { prefix: '/api/sns/posts' });
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.register(lineWebhookRoutes, { prefix: '/api/webhooks/line' });
  await app.register(inboxMessagesRoutes, { prefix: '/api/inbox/messages' });
  await app.register(inboxConnectionsRoutes, { prefix: '/api/inbox/connections' });
  await app.register(integrationsRoutes, { prefix: '/api/integrations' });
  await app.register(oauthGoogleRoutes, { prefix: '/api/oauth/google' });
  await app.register(accountingRoutes, { prefix: '/api/accounting' });
  await app.register(memberRoutes, { prefix: '/api/members' });

  const port = parseInt(process.env.PORT ?? '4000');
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API Gateway running on port ${port}`);

  // デプロイ・再起動で RUNNING のまま取り残されたエージェント実行を回収する。
  // 放置すると受信ページにも一覧にも「実行中」のまま永久に残るため、起動直後に一度だけ掃除する。
  void recoverStaleRunningTasks()
    .then((n) => {
      if (n > 0) console.log(`[startup] 中断された実行 ${n} 件を回収しました`);
    })
    .catch((e) => console.error('[startup] stale task recovery failed:', e));

  // 定期実行の gateway 内 tick（n8n schedule-dispatcher が未インポートでも定期実行が動く保険。
  // 併走しても enqueue 側の atomic claim が二重発火を防ぐ）
  startInternalScheduler();

  /* ⚠️ Render はデプロイのたびに SIGTERM を送る。これが無いと、応答後も裏で走っている
     処理（エージェント実行・RAG索引・領収書読み取り・返信下書き）が途中で切られ、
     Task は RUNNING のまま残り、受信箱の処理は誰にも拾われず消える。 */
  installShutdownHandlers(app);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
