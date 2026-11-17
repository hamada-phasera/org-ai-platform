// レート制限（@fastify/rate-limit、メモリ保持。計画書 D8）。
//
// ■ 上限（IP ごと・1 分）
//   全体 300 回 / 登録とログイン 10 回 / 招待のプレビューと受諾 20 回。
//   ルートごとの上限は、各ルートの `config.rateLimit` に下の定数を書く（全体の上限の代わりにそれが効く）。
// ■ 除外
//   Stripe / LINE の webhook（署名で守られていて、送り元は少数の IP にまとまる）と /health（死活監視）。
// ■ IP
//   Render の背後なので、転送ヘッダ（X-Forwarded-For）から取る。Fastify の trustProxy に
//   config.trustProxyHops（既定 1 = 直前のプロキシが付けた値だけを信じる）を渡すこと。
//   ⚠️ trustProxy: true（全部信じる）にすると、利用者が X-Forwarded-For を自分で書いて制限をすり抜けられる。
// ⚠️ 保持はプロセスのメモリ。gateway を複数台にするときは store を Redis 等に替える。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createLogger } from '../utils/logger';

const log = createLogger('rate-limit');

const MINUTE_MS = 60_000;

export const GLOBAL_RATE_LIMIT = { max: 300, timeWindow: MINUTE_MS } as const;
/** /api/auth/login と /api/auth/register */
export const AUTH_RATE_LIMIT = { max: 10, timeWindow: MINUTE_MS } as const;
/** 招待のプレビューと受諾（トークンの当てずっぽう対策） */
export const INVITE_RATE_LIMIT = { max: 20, timeWindow: MINUTE_MS } as const;

/** 制限しないパス（前方一致。クエリは除いて比べる）。 */
const EXEMPT_PREFIXES = ['/api/webhooks/stripe', '/api/webhooks/line'];
const EXEMPT_EXACT = ['/health'];

export function isRateLimitExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (EXEMPT_EXACT.includes(path)) return true;
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** 429 の本文。統一フォーマット（{ success: false, error: { code, message } }）に Fastify が使う statusCode を足す。 */
export function rateLimitedBody(): { statusCode: 429; success: false; error: { code: 'RATE_LIMITED'; message: string } } {
  return {
    statusCode: 429,
    success: false,
    error: { code: 'RATE_LIMITED', message: 'リクエストが多すぎます。しばらく待ってからもう一度お試しください。' },
  };
}

/** ルートより先に登録すること（後から足したルートにだけ効く）。 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    ...GLOBAL_RATE_LIMIT,
    allowList: (request: FastifyRequest) => isRateLimitExempt(request.url),
    errorResponseBuilder: () => rateLimitedBody(),
    onExceeded: (request: FastifyRequest) => {
      // IP は運用で追うのに要る。パスはクエリを除く（招待トークン等を残さない）
      log.warn(`制限を超えました ${request.method} ${request.routeOptions?.url ?? '-'} ip=${request.ip}`);
    },
  });
}
