// 統一エラーフォーマット `{ success: false, error: { code, message } }` を作る唯一の場所。
// ルートはここを通してエラーを返す（形を変えるときに1か所で済むように）。

import type { FastifyInstance, FastifyReply } from 'fastify';

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

/**
 * このプラグインの中のルートで、bodyLimit 超過の 413 を統一フォーマット（`PAYLOAD_TOO_LARGE`）に書き換える。
 * Fastify の既定の本文（英語・`statusCode` の形）だと web も n8n の構築者も理由が読めないため。
 *
 * setErrorHandler ではなく onSend で置き換える: エラーハンドラから投げ直すと、レート制限の 429 のような
 * Error でない値が 200 で返ってしまう（Fastify 4）。onSend なら 413 の既定の本文だけを見て、他の応答には触れない。
 * ⚠️ プラグインの中（カプセル化された app）で呼ぶこと。ルートの app 全体には付けない。
 */
export function sendBodyTooLargeAsError(app: FastifyInstance, message: string): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode !== 413 || typeof payload !== 'string' || !payload.includes('FST_ERR_CTP_BODY_TOO_LARGE')) {
      return payload;
    }
    reply.header('content-type', 'application/json; charset=utf-8');
    return JSON.stringify(errorBody('PAYLOAD_TOO_LARGE', message));
  });
}
