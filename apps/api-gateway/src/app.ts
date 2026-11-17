// gateway のアプリの組み立て（プラグイン・起動チェック・レート制限・全ルート）。listen はしない。
//
// 本番（index.ts）と統合テスト（tests/integration/app.ts）が同じこの関数を使う。
// 統合テストが本番と違う配線（レート制限なし・起動チェックなし・ルートの一部だけ）で通っていた穴を塞ぐ（saas-review #5c）。
// ⚠️ ここにはリクエストの外で動くもの（定期 tick・取り残しの回収・シャットダウン）を置かない。それは index.ts。

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { PLAN_LIMITS } from '@org-ai/shared-types';
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
import { billingRoutes } from './routes/billing';
import { stripeWebhookRoutes } from './routes/billing-webhook';
import { prisma } from './utils/prisma';
import { config, ENV_DEFAULTS } from './config/env';
import { registerTenantContext } from './tenancy/context';
import { assertStartupConfig } from './config/startup-checks';
import { registerRateLimit } from './middleware/rate-limit';
import { healthRoutes } from './routes/health';

export interface BuildAppOptions {
  /** Fastify の logger（本番は true、テストは false） */
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  /* Render の背後にいるので、利用者の IP は X-Forwarded-For から取る（レート制限の単位）。
     ⚠️ 段数で指定する（true にすると利用者が書いたヘッダまで信じてしまう）。 */
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: config.trustProxyHops });

  // 起動してはいけない設定（JWT_SECRET が短い・本番で n8n トークンが既定値）はここで止める
  assertStartupConfig();

  // 明示許可リスト (FRONTEND_URL, カンマ区切り) + localhost + 自分のフロントのみ許可。
  // 以前は *.vercel.app 全許可 + credentials:true で、任意の Vercel ユーザーのサイトから
  // 資格情報付きリクエストが可能だった（本番検証時の指摘）。
  //
  // Vercel のホスト名は 3 種類あるので取りこぼすとフロントが全滅する:
  //   - 本番エイリアス: org-ai-platform.vercel.app（実際に公開されているのはこれ）
  //   - プロジェクトエイリアス: flow-hamahiro1668s-projects.vercel.app
  //   - デプロイ毎: flow-<hash>-hamahiro1668s-projects.vercel.app（毎回変わる）
  // 末尾のアカウント固有サフィックスは他人が取得できないため、これだけワイルドカードにする。
  const explicitOrigins = (config.frontendUrlRaw ?? ENV_DEFAULTS.FRONTEND_URL)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*');
  const extraHosts = config.allowedOriginHosts;
  const vercelSuffix = config.vercelPreviewSuffix;
  await app.register(cors, {
    origin: (origin, cb) => {
      // 同一オリジン / 非ブラウザ (origin 無し) は許可
      if (!origin) return cb(null, true);
      let host: string;
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

  // 長さは assertStartupConfig で確認済み
  await app.register(jwt, { secret: config.jwtSecret as string });

  // 1ファイルの上限はプランごとに違い、files.ts が request.file() の limits で個別に絞る。
  // ここは全プランの最大値。プランの上限を上げたときに直し忘れないよう、表から計算する
  await app.register(multipart, {
    limits: { fileSize: Math.max(...Object.values(PLAN_LIMITS).map((l) => l.maxFileBytes)) },
  });
  await app.register(websocket);

  // テナントコンテキスト（request.tenant と AsyncLocalStorage）。ルートより先に配線する
  registerTenantContext(app);

  // レート制限。⚠️ ルートより先に登録する（後から足したルートにだけ効く）
  await registerRateLimit(app);

  await app.register(healthRoutes, { pingDb: () => prisma.$queryRaw`SELECT 1` });

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
  await app.register(billingRoutes, { prefix: '/api/billing' });
  await app.register(stripeWebhookRoutes, { prefix: '/api/webhooks/stripe' });

  return app;
}
