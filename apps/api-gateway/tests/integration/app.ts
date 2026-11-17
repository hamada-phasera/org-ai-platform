// 統合テスト用の gateway（本物のルート・requireAuth・tenantDb・multipart）。
// DB だけテストファイルが vi.mock('../../src/utils/prisma') で実 Postgres のクライアントに向ける。
// ⚠️ モジュールは関数の中で import する（テストファイルの vi.mock が先に効くように）。

import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { expect } from 'vitest';

export const INT_JWT_SECRET = 'integration-test-secret-32-chars-long!!';

export async function buildIntegrationApp(): Promise<FastifyInstance> {
  const { registerTenantContext } = await import('../../src/tenancy/context');
  const { authRoutes } = await import('../../src/routes/auth');
  const { billingRoutes } = await import('../../src/routes/billing');
  const { stripeWebhookRoutes } = await import('../../src/routes/billing-webhook');
  const { organizationRoutes } = await import('../../src/routes/organizations');
  const { fileRoutes } = await import('../../src/routes/files');

  const app = Fastify();
  await app.register(jwt, { secret: INT_JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  registerTenantContext(app);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(billingRoutes, { prefix: '/api/billing' });
  await app.register(stripeWebhookRoutes, { prefix: '/api/webhooks/stripe' });
  await app.register(organizationRoutes, { prefix: '/api/organizations' });
  await app.register(fileRoutes, { prefix: '/api/files' });
  await app.ready();
  return app;
}

export interface Registered {
  token: string;
  orgId: string;
  userId: string;
  headers: { authorization: string };
}

export async function registerCompany(app: FastifyInstance, email: string, orgName: string): Promise<Registered> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { name: '担当', email, password: 'password123', orgName },
  });
  expect(res.statusCode).toBe(201);
  const data = res.json().data;
  return { token: data.token, orgId: data.user.orgId, userId: data.user.id, headers: { authorization: `Bearer ${data.token}` } };
}

export function multipartBody(filename: string, mime: string, content: Buffer) {
  const boundary = '----flowIntegrationBoundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export async function upload(app: FastifyInstance, who: Registered, name: string, content: Buffer) {
  const body = multipartBody(name, 'text/plain', content);
  return app.inject({ method: 'POST', url: '/api/files/upload', payload: body.payload, headers: { ...body.headers, ...who.headers } });
}
