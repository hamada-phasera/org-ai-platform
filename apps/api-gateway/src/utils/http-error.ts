// 統一エラーフォーマット `{ success: false, error: { code, message } }` を作る唯一の場所。
// ルートはここを通してエラーを返す（形を変えるときに1か所で済むように）。

import type { FastifyReply } from 'fastify';

export interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

/** 統一フォーマットのエラー本文。 */
export function errorBody(code: string, message: string): ErrorBody {
  return { success: false, error: { code, message } };
}

/** ステータスを付けて統一フォーマットのエラーを返す。`return sendError(...)` で使う。 */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send(errorBody(code, message));
}

/**
 * 上流（ai-engine 等）のエラーステータスをこちらの応答ステータスに写す。
 * 5xx は 502（上流の障害）にまとめ、4xx はそのまま返す。
 */
export function upstreamStatus(status: number): number {
  return status >= 500 ? 502 : status;
}
