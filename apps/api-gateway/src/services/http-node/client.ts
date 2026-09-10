// カスタム HTTP ノードの送信層。**この1ファイルだけが undici を直接使う**。
//
// なぜ Node 組み込みの fetch ではないか:
//   組み込み fetch に外部 undici の Agent を dispatcher として渡す構成は、内部 symbol の
//   版差で dispatcher が黙って無視されることがある。つまり **SSRF ガードが外れたことに
//   気づけない**。fetch と Agent を同一パッケージから取れば構造的に不整合しない。
//
// なぜ undici の fetch ではなく request か:
//   - 既定でリダイレクトを一切追わない（maxRedirections を渡さない限り）。
//     fetch の redirect:'manual' は status 0 の不透明応答になり分岐が曖昧になる。
//   - statusCode が生で取れるので 3xx を明示的にエラーにできる。
//   - body が Readable なので、サイズ上限を**全部読む前に**打ち切れる。
//
// ⚠️ ProxyAgent は導入しない。プロキシ経由になると connect.lookup のピン留めが
//    無効化され、DNS リバインディング対策が丸ごと効かなくなる。
// ⚠️ TLS 検証を無効化するオプションも作らない。

import { Agent, request } from 'undici';
import { createGuardedLookup } from './url-guard';

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_NODE_TIMEOUT_MS ?? 15_000);
export const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = Number(process.env.HTTP_NODE_MAX_RESPONSE_BYTES ?? 256 * 1024);

/** 読み取ってよい Content-Type。これ以外は body を読まずに捨てる。 */
const ALLOWED_CONTENT_TYPES = [
  'application/json',
  '+json',
  'text/plain',
  'text/csv',
  'application/xml',
  'text/xml',
];

let agent: Agent | null = null;

/** 解決済み IP にピン留めする Agent。lookup が実際の接続先を決めるので、ここが防御の要。 */
function getAgent(): Agent {
  if (!agent) {
    agent = new Agent({
      connect: {
        lookup: createGuardedLookup(),
        timeout: 5_000,
        rejectUnauthorized: true,
      },
      connections: 8,
      pipelining: 0,
      // ⚠️ Agent は使い回すので、ここはリクエスト毎の上限にできない。
      //    10s のような短い固定値にすると、timeoutMs=30000 で保存したノードでも
      //    ヘッダが 10s で切られ、しかも下の catch で NETWORK に化けて
      //    「接続できませんでした」と出る（＝設定を疑い続けることになる）。
      //    実際の打ち切りは AbortSignal.timeout(timeoutMs) に任せる。
      headersTimeout: MAX_TIMEOUT_MS,
      bodyTimeout: MAX_TIMEOUT_MS,
    });
  }
  return agent;
}

/** テスト用に Agent を捨てる（env を変えたあとに呼ぶ）。 */
export function resetHttpNodeAgent(): void {
  agent = null;
}

export type GuardedResponse =
  | { ok: true; statusCode: number; contentType: string; body: unknown; raw: string }
  | { ok: false; kind: 'STATUS'; statusCode: number; snippet: string; retryAfter: string | null }
  | { ok: false; kind: 'REDIRECT'; statusCode: number }
  | { ok: false; kind: 'CONTENT_TYPE'; contentType: string }
  | { ok: false; kind: 'TOO_LARGE' }
  | { ok: false; kind: 'TIMEOUT' }
  | { ok: false; kind: 'NETWORK'; message: string }
  | { ok: false; kind: 'BLOCKED' };

export interface GuardedRequestInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

function isAllowedContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return ALLOWED_CONTENT_TYPES.some((t) => lower.includes(t));
}

/**
 * 応答本文を読まずに捨てる。
 *
 * ⚠️ `destroy()` を素で呼んではいけない。破棄で Readable が 'error' を出したとき、
 *    リスナが1つも付いていないと Node は unhandled 'error' として
 *    **プロセスごと落とす**。api-gateway は全 API の入口なので、
 *    リダイレクトを1回踏まれるだけで全社が止まることになる。
 *    先に握り潰しのリスナを付けてから破棄する。
 */
function discardBody(body: unknown): void {
  const b = body as { on?: (ev: string, fn: () => void) => void; destroy?: () => void };
  try {
    if (typeof b?.on === 'function') b.on('error', () => {});
    if (typeof b?.destroy === 'function') b.destroy();
  } catch {
    /* 破棄に失敗しても送信結果の判定は変えない */
  }
}

/** ヘッダ値は重複すると配列で来る。先頭だけを見る（String() だとカンマ連結される）。 */
function headerValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** 本文を持たないことが決まっている応答か（RFC 9110）。 */
function isBodyless(statusCode: number, contentLength: string): boolean {
  return statusCode === 204 || statusCode === 205 || statusCode === 304 || contentLength === '0';
}

/**
 * ガード付きの送信。リダイレクトを追わず、サイズと Content-Type を制限する。
 * ⚠️ 戻り値にヘッダを含めない（資格情報がそのまま返る経路を作らない）。
 */
export async function sendGuardedRequest(input: GuardedRequestInput): Promise<GuardedResponse> {
  const timeout = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  try {
    const res = await request(input.url, {
      method: input.method as 'GET',
      headers: input.headers,
      ...(input.body !== undefined && input.body !== null
        ? { body: JSON.stringify(input.body) }
        : {}),
      dispatcher: getAgent(),
      // maxRedirections を渡さない = リダイレクトを追わない。
      // 追うと「1回目だけガードを通った公開ホスト」が 302 で内部へ誘導できる。
      signal: AbortSignal.timeout(timeout),
    });

    if (res.statusCode >= 300 && res.statusCode < 400) {
      discardBody(res.body);
      return { ok: false, kind: 'REDIRECT', statusCode: res.statusCode };
    }

    const contentType = headerValue(res.headers['content-type'] as string | string[] | undefined);
    const contentLength = headerValue(res.headers['content-length'] as string | string[] | undefined);

    // 204 No Content や Content-Type を返さない 201 は「本文なしの成功」。
    // ここを Content-Type 判定に掛けると、**書き込み系ノードがほぼ全滅する**
    // （DELETE→204 / POST→201 Content-Length:0 を返す API は珍しくない）。
    // 外部側の副作用は既に起きているのに失敗表示になり、人が再実行して二重送信する。
    if (res.statusCode < 400 && (isBodyless(res.statusCode, contentLength) || contentType === '')) {
      discardBody(res.body);
      return { ok: true, statusCode: res.statusCode, contentType, body: null, raw: '' };
    }

    if (res.statusCode < 400 && !isAllowedContentType(contentType)) {
      // 画像やバイナリを {{prev}} と ExecutionLog に流し込まない
      discardBody(res.body);
      return { ok: false, kind: 'CONTENT_TYPE', contentType };
    }

    // サイズ上限はストリームで打ち切る（全部バッファリングしてから捨てない）
    let size = 0;
    const chunks: Buffer[] = [];
    let tooLarge = false;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > MAX_RESPONSE_BYTES) {
        tooLarge = true;
        discardBody(res.body);
        break;
      }
      chunks.push(buf);
    }
    if (tooLarge) return { ok: false, kind: 'TOO_LARGE' };

    const raw = Buffer.concat(chunks).toString('utf8');

    if (res.statusCode >= 400) {
      return {
        ok: false,
        kind: 'STATUS',
        statusCode: res.statusCode,
        snippet: raw.slice(0, 200),
        retryAfter: headerValue(res.headers['retry-after'] as string | string[] | undefined) || null,
      };
    }

    let parsed: unknown = raw;
    if (contentType.toLowerCase().includes('json')) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return { ok: true, statusCode: res.statusCode, contentType, body: parsed, raw };
  } catch (e) {
    const err = e as { name?: string; code?: string; message?: string };
    if (err?.code === 'ERR_BLOCKED_DESTINATION') return { ok: false, kind: 'BLOCKED' };
    // ⚠️ undici が実際に投げるのは ConnectTimeoutError / HeadersTimeoutError /
    //    BodyTimeoutError で、どれも name は 'TimeoutError' ではない。
    //    名前だけで判定すると「無応答の遅い API」という一番多いケースが
    //    NETWORK に落ち、「接続できませんでした」という誤った文言になる。
    const TIMEOUT_CODES = [
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ];
    if (
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      (err?.code !== undefined && TIMEOUT_CODES.includes(err.code))
    ) {
      return { ok: false, kind: 'TIMEOUT' };
    }
    // ⚠️ message をそのまま利用者に返さない（呼び出し側で一般化した文言に変換する）
    return { ok: false, kind: 'NETWORK', message: err?.message ?? 'network error' };
  }
}

// ── org 単位の送信レート制限（プロセス内） ──────────────────────
// 自社 IP から第三者 API を乱打してレピュテーションを落とさないための保険。
// ⚠️ プロセス内なのでマルチインスタンスでは厳密でない（n8n credential キャッシュと同水準）。

const RATE_PER_MIN = Number(process.env.HTTP_NODE_RATE_PER_MIN ?? 60);
const buckets = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(orgId: string, now: number = Date.now()): boolean {
  const bucket = buckets.get(orgId);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    buckets.set(orgId, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= RATE_PER_MIN) return false;
  bucket.count += 1;
  return true;
}

/** テスト用。 */
export function resetRateLimits(): void {
  buckets.clear();
}
