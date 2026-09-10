import { describe, it, expect } from 'vitest';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';

/**
 * OAuth の state 署名が「ログイン JWT として通らない」ことを守るテスト。
 *
 * routes/oauth-google.ts の signState / verifyState と同じ実装をここに写している
 * （ルートは Fastify インスタンスを要求するため、署名部分だけを取り出して検証する）。
 * 実装を変えたらこちらも合わせること。守りたい性質は最後の2ケース。
 */

const JWT_SECRET = 'test-secret-that-is-long-enough-for-validation-32';

function stateKey(): Buffer {
  return createHash('sha256').update(`oauth-state:${JWT_SECRET}`).digest();
}

function signState(payload: { nonce: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', stateKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(raw: string): boolean {
  const parts = raw.split('.');
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expected = createHmac('sha256', stateKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

describe('OAuth state の署名', () => {
  it('自分で発行した state は検証を通る', () => {
    const s = signState({ nonce: randomUUID(), exp: Date.now() + 600_000 });
    expect(verifyState(s)).toBe(true);
  });

  it('期限切れは弾く', () => {
    const s = signState({ nonce: randomUUID(), exp: Date.now() - 1 });
    expect(verifyState(s)).toBe(false);
  });

  it('本文を1文字でも書き換えたら弾く', () => {
    const s = signState({ nonce: randomUUID(), exp: Date.now() + 600_000 });
    const [body, sig] = s.split('.');
    const tampered = `${body.slice(0, -1)}${body.slice(-1) === 'A' ? 'B' : 'A'}.${sig}`;
    expect(verifyState(tampered)).toBe(false);
  });

  it('署名が欠けている / 形式が違うものは弾く', () => {
    expect(verifyState('')).toBe(false);
    expect(verifyState('abc')).toBe(false);
    expect(verifyState('a.b.c')).toBe(false);
  });

  // ── ここが本題（権限昇格の防止） ──

  it('state はログイン JWT として検証を通らない（API のベアラトークンにならない）', async () => {
    const app = Fastify();
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    const s = signState({ nonce: randomUUID(), exp: Date.now() + 600_000 });
    // requireAuth は request.jwtVerify() = この鍵での検証。state が通ってはいけない。
    expect(() => app.jwt.verify(s)).toThrow();
    await app.close();
  });

  it('ログイン JWT を state として持ち込んでも通らない（鍵が用途で分かれている）', async () => {
    const app = Fastify();
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    const loginToken = app.jwt.sign({ sub: 'u1', orgId: 'org-1', role: 'OWNER' });
    expect(verifyState(loginToken)).toBe(false);
    await app.close();
  });
});

/**
 * リダイレクト先の決定（routes/oauth-google.ts の frontendBase と同じ規則）。
 * 本番の FRONTEND_URL が '*' で localhost に飛んでいた実測の回帰を防ぐ。
 */
function frontendBase(env: { FRONTEND_URL?: string; ALLOWED_ORIGIN_HOSTS?: string }): string {
  const fallback = 'http://localhost:3000';
  const candidates = (env.FRONTEND_URL ?? '').split(',').map((s) => s.trim());
  for (const c of candidates) {
    if (!c || c === '*') continue;
    try {
      const u = new URL(c);
      if (u.protocol === 'http:' || u.protocol === 'https:') return c.replace(/\/$/, '');
    } catch {
      /* 次の候補へ */
    }
  }
  const allowedHost = (env.ALLOWED_ORIGIN_HOSTS ?? 'org-ai-platform.vercel.app')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (allowedHost) return `https://${allowedHost}`;
  return fallback;
}

describe('OAuth 後のリダイレクト先', () => {
  it('FRONTEND_URL が妥当ならそれを使う', () => {
    expect(frontendBase({ FRONTEND_URL: 'https://app.example.com/' })).toBe('https://app.example.com');
  });

  it("FRONTEND_URL が '*' でも localhost に飛ばさず本番フロントへ戻す（本番の実測ケース）", () => {
    expect(frontendBase({ FRONTEND_URL: '*' })).toBe('https://org-ai-platform.vercel.app');
  });

  it('FRONTEND_URL 未設定でも本番フロントへ戻す', () => {
    expect(frontendBase({})).toBe('https://org-ai-platform.vercel.app');
  });

  it('カンマ区切りの先頭にある妥当な URL を採る', () => {
    expect(frontendBase({ FRONTEND_URL: '*,https://app.example.com' })).toBe('https://app.example.com');
  });

  it('許可ホストも無ければ localhost（開発）', () => {
    expect(frontendBase({ FRONTEND_URL: '*', ALLOWED_ORIGIN_HOSTS: '' })).toBe('http://localhost:3000');
  });
});
