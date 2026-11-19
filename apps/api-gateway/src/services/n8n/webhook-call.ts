// n8n の Webhook を叩く共通部分（業務ページの action-runner と業務フローの part-client が使う。canvas-home.md §8.2）。
//
// ■ URL は呼び出し側が組み立てる（ベースは環境変数だけ。入るのは許可リストの文字だけ）。ここでは組み立てない。
// ■ 常に POST・`x-org-ai-token`（既存の Header Auth）・リダイレクトは追わない（redirect: 'error'）。
// ■ 応答は JSON のみ・`maxBytes` まで。失敗は理由だけを返し、上流の本文は返さない（T9・T19）。
// ■ 再試行は接続エラーのときだけ（呼び出し側が許したときに 1 回）。タイムアウト・4xx/5xx はやり直さない。
// ⚠️ n8n の public API（/api/v1/）はここから呼ばない。お客さんの操作から n8n のワークフローを作る経路を作らない（T22）。

import { config } from '../../config/env';

/** 応答の上限の既定（T9） */
export const N8N_WEBHOOK_RESPONSE_MAX_BYTES = 256 * 1024;

export type WebhookFailure = 'FAILED' | 'TIMEOUT' | 'INVALID_RESPONSE';
export type WebhookResult =
  | { ok: true; json: unknown; durationMs: number; attempts: number }
  | { ok: false; reason: WebhookFailure; durationMs: number; attempts: number };

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

class ResponseTooLarge extends Error {}

/** Content-Type が JSON で、`maxBytes` 以内なら JSON を返す。それ以外は null（読むのをやめる） */
async function readJsonLimited(res: Response, maxBytes: number): Promise<{ value: unknown } | null> {
  const type = (res.headers.get('content-type') ?? '').trim().toLowerCase();
  const declared = Number(res.headers.get('content-length'));
  if (!/^application\/json(\s*;|$)/.test(type) || (Number.isFinite(declared) && declared > maxBytes) || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLarge();
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (e instanceof ResponseTooLarge) return null;
    throw e;
  }
  const text = new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

export interface CallN8nWebhookArgs {
  url: string;
  body: unknown;
  /** 接続エラーのときだけ 1 回やり直すか（副作用の無い呼び出しだけ true） */
  retryOnConnectionError: boolean;
  timeoutMs: number;
  maxBytes?: number;
}

/** n8n の Webhook を 1 回（許されていれば接続エラー時にもう 1 回）叩く。失敗の理由だけを返し、本文は返さない */
export async function callN8nWebhook(args: CallN8nWebhookArgs): Promise<WebhookResult> {
  const started = Date.now();
  const maxBytes = args.maxBytes ?? N8N_WEBHOOK_RESPONSE_MAX_BYTES;
  const tries = args.retryOnConnectionError ? 2 : 1;
  let attempts = 0;
  const done = (r: { ok: true; json: unknown } | { ok: false; reason: WebhookFailure }): WebhookResult => ({
    ...r,
    durationMs: Date.now() - started,
    attempts,
  });

  for (let attempt = 1; attempt <= tries; attempt++) {
    attempts = attempt;
    let res: Response;
    try {
      res = await fetch(args.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(args.timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-org-ai-token': config.n8nWebhookAuthToken },
        body: JSON.stringify(args.body),
      });
    } catch (e) {
      if (isTimeout(e)) return done({ ok: false, reason: 'TIMEOUT' });
      if (attempt < tries) continue; // 接続エラー（とリダイレクト）だけやり直す
      return done({ ok: false, reason: 'FAILED' });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return done({ ok: false, reason: 'FAILED' });
    }
    try {
      const parsed = await readJsonLimited(res, maxBytes);
      return parsed ? done({ ok: true, json: parsed.value }) : done({ ok: false, reason: 'INVALID_RESPONSE' });
    } catch (e) {
      return done({ ok: false, reason: isTimeout(e) ? 'TIMEOUT' : 'FAILED' });
    }
  }
  return done({ ok: false, reason: 'FAILED' });
}
