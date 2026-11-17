import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../src/routes/health';

// チャンク 7: /ready の 503 に例外の文言（接続先・ユーザー名など）を返さない

describe('/ready', () => {
  it('DB に届けば 200', async () => {
    const app = Fastify();
    await app.register(healthRoutes, { pingDb: async () => 1 });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().db).toBe('connected');
    await app.close();
  });

  it('⚠️ 503 の応答は固定文言だけ。例外の文言はログにだけ出す', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretish = "Can't reach database server at db.internal-host.example:5432 user=flow_admin";
    const app = Fastify();
    await app.register(healthRoutes, { pingDb: async () => { throw new Error(secretish); } });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'disconnected' });
    expect(res.body).not.toContain('internal-host');
    expect(res.body).not.toContain('flow_admin');
    expect(err).toHaveBeenCalled();
    await app.close();
  });

  it('/health は DB を見ない', async () => {
    const ping = vi.fn();
    const app = Fastify();
    await app.register(healthRoutes, { pingDb: ping });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect(ping).not.toHaveBeenCalled();
    await app.close();
  });
});
