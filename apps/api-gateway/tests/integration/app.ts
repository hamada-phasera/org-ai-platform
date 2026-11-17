// 統合テスト用の gateway。本番と同じ buildApp（src/app.ts: 起動チェック・レート制限・trustProxy・全ルート）を使う
// （saas-review #5c: 以前はルートの一部だけを手で登録していて、本番の配線を通っていなかった）。
// DB だけテストファイルが vi.mock('../../src/utils/prisma') で実 Postgres のクライアントに向ける。
// ⚠️ モジュールは関数の中で import する（テストファイルの vi.mock が先に効くように）。

import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

export const INT_JWT_SECRET = 'integration-test-secret-32-chars-long!!';

export async function buildIntegrationApp(): Promise<FastifyInstance> {
  // 起動チェック（assertStartupConfig）は JWT_SECRET の長さを見る。テストの環境に無ければ入れる
  process.env.JWT_SECRET ??= INT_JWT_SECRET;
  const { buildApp } = await import('../../src/app');
  const app = await buildApp({ logger: false });
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
