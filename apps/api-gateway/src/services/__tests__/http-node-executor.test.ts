import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.CHANNEL_CREDENTIAL_ENC_KEY = 'b'.repeat(64);
process.env.HTTP_NODE_RATE_PER_MIN = '1000';

const prismaMock = {
  capability: { update: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

/** undici をモックする。⚠️ グローバル fetch のモックでは**この経路を満たせない**
 *  （client.ts は undici の request を使う）。それが逆に安全側の担保になっている。 */
const requestMock = vi.fn();
vi.mock('undici', () => ({
  Agent: class {
    constructor(_opts?: unknown) {}
  },
  request: (...args: unknown[]) => requestMock(...args),
}));

const { executeHttpCapabilityDetailed, classifyHttpStatus } = await import('../http-node/executor');
const { sealSecret } = await import('../secret-box');
const { resetRateLimits } = await import('../http-node/client');

/** undici の request 返り値を作る。body は async iterable。 */
function reply(statusCode: number, body: string, headers: Record<string, string> = {}) {
  return rawReply(statusCode, body, { 'content-type': 'application/json', ...headers });
}

/** Content-Type を含む既定ヘッダを一切足さない版。204 など本文なしの応答を作るのに使う。 */
function rawReply(statusCode: number, body: string, headers: Record<string, string> = {}) {
  const destroy = vi.fn();
  const on = vi.fn();
  return {
    statusCode,
    headers,
    body: Object.assign(
      (async function* () {
        yield Buffer.from(body);
      })(),
      { destroy, on },
    ),
    __destroy: destroy,
    __on: on,
  };
}

const CAP = {
  id: 'cap-1',
  name: 'fetch_deal',
  httpConfig: {
    version: 1 as const,
    method: 'GET' as const,
    url: 'https://api.example.com/v1/deals/{{dealId}}',
    headers: [{ name: 'Authorization', value: sealSecret('Bearer sk-live-SECRET'), secret: true }],
    bodyTemplate: null,
    outputPath: 'data',
    timeoutMs: 15000,
    params: [{ name: 'dealId', type: 'string' as const, required: true }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  prismaMock.capability.update.mockResolvedValue({});
  delete process.env.HTTP_NODE_ENABLED;
});

describe('classifyHttpStatus', () => {
  it('401/403 は再接続要求（AUTH_MISSING かつ authDead）', () => {
    expect(classifyHttpStatus(401)).toMatchObject({ errorType: 'AUTH_MISSING', authDead: true });
    expect(classifyHttpStatus(403)).toMatchObject({ errorType: 'AUTH_MISSING', authDead: true });
  });
  it('429 は RATE_LIMIT で Retry-After を文言に載せる', () => {
    const c = classifyHttpStatus(429, '30');
    expect(c.errorType).toBe('RATE_LIMIT');
    expect(c.message).toContain('30');
    expect(c.authDead).toBe(false);
  });
  it('5xx は一時故障の文言（再接続を促さない）', () => {
    const c = classifyHttpStatus(503);
    expect(c.errorType).toBe('NODE_FAILED');
    expect(c.message).toContain('一時的');
    expect(c.authDead).toBe(false);
  });
  it('4xx は設定確認の文言', () => {
    expect(classifyHttpStatus(404).message).toContain('設定');
  });
});

describe('executeHttpCapabilityDetailed', () => {
  it('成功: outputPath で抽出した値が envelope.data に入る', async () => {
    requestMock.mockResolvedValue(reply(200, JSON.stringify({ data: { amount: 1000 } })));

    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    expect(r.envelope.status).toBe('success');
    expect(r.envelope.data).toEqual({ amount: 1000 });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(String(requestMock.mock.calls[0][0])).toBe('https://api.example.com/v1/deals/D-1');
  });

  it('シークレットヘッダは復号して送るが、戻り値には平文も暗号文も出さない', async () => {
    requestMock.mockResolvedValue(reply(200, JSON.stringify({ data: 'ok' })));

    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    const sentHeaders = (requestMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    // ヘッダ名は送信前に小文字へ正規化される（Content-Type の二重送信を防ぐため）
    expect(sentHeaders.authorization).toBe('Bearer sk-live-SECRET');
    const serialized = JSON.stringify(r.envelope);
    expect(serialized).not.toContain('sk-live-SECRET');
    expect(serialized).not.toContain('v1:');
  });

  it('401 で authDead を返し、capability を NEEDS_AUTH に落とす', async () => {
    requestMock.mockResolvedValue(reply(401, '{"error":"bad token"}'));

    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    expect(r.authDead).toBe(true);
    expect(r.envelope.error_type).toBe('AUTH_MISSING');
  });

  it('3xx はリダイレクトとして落とし、2回目のリクエストを出さない', async () => {
    const res = reply(302, '', { location: 'https://169.254.169.254/' });
    requestMock.mockResolvedValue(res);

    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    expect(r.envelope.status).toBe('error');
    expect(r.envelope.message).toContain('リダイレクト');
    expect(requestMock).toHaveBeenCalledTimes(1); // 追わない
    expect(res.__destroy).toHaveBeenCalled();
  });

  it('許可されない Content-Type は body を読まずに捨てる', async () => {
    const res = reply(200, 'binary', { 'content-type': 'image/png' });
    requestMock.mockResolvedValue(res);

    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    expect(r.envelope.status).toBe('error');
    expect(res.__destroy).toHaveBeenCalled();
  });

  it('展開後 URL が内部宛てになるならリクエストを1度も出さない', async () => {
    const cap = {
      ...CAP,
      httpConfig: { ...CAP.httpConfig, url: 'https://localhost/{{dealId}}' },
    };

    const r = await executeHttpCapabilityDetailed(cap, { dealId: 'x' }, 'org-1');

    expect(r.envelope.error_type).toBe('VALIDATION_ERROR');
    expect(requestMock).not.toHaveBeenCalled();
    // 「内部だった」ことを利用者に明かさない
    expect(r.envelope.message).not.toContain('localhost');
  });

  it('未宣言のパラメータは送信前に落ちる', async () => {
    const r = await executeHttpCapabilityDetailed(CAP, {}, 'org-1');
    expect(r.envelope.error_type).toBe('VALIDATION_ERROR');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('httpConfig が壊れていたら送信しない（DB を信用しない）', async () => {
    const r = await executeHttpCapabilityDetailed(
      { id: 'c', name: 'broken', httpConfig: { method: 'GET' } },
      {},
      'org-1',
    );
    expect(r.envelope.error_type).toBe('VALIDATION_ERROR');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('outputPath が解決できないときは成功にしない（{{prev}} が黙って空になるのを防ぐ）', async () => {
    requestMock.mockResolvedValue(reply(200, JSON.stringify({ other: 1 })));

    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    expect(r.envelope.status).toBe('error');
    expect(r.envelope.message).toContain('data');
  });

  it('キルスイッチが効く', async () => {
    process.env.HTTP_NODE_ENABLED = 'false';
    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');
    expect(r.envelope.status).toBe('error');
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('204 No Content は成功として扱う（書き込み系ノードが全滅しない）', async () => {
    // ⚠️ ここが失敗扱いだと、外部側の副作用は起きているのに Task が FAILED になり、
    //    人が再実行して二重送信する
    const cap = { ...CAP, httpConfig: { ...CAP.httpConfig, method: 'POST' as const, outputPath: '' } };
    requestMock.mockResolvedValue(rawReply(204, '', {}));

    const r = await executeHttpCapabilityDetailed(cap, { dealId: 'D-1' }, 'org-1');

    expect(r.envelope.status).toBe('success');
    expect(r.envelope.data).toBeNull();
  });

  it('Content-Type を返さない 201 も成功として扱う', async () => {
    const cap = { ...CAP, httpConfig: { ...CAP.httpConfig, method: 'POST' as const, outputPath: '' } };
    requestMock.mockResolvedValue(rawReply(201, '', { 'content-length': '0' }));

    const r = await executeHttpCapabilityDetailed(cap, { dealId: 'D-1' }, 'org-1');

    expect(r.envelope.status).toBe('success');
  });

  it('本文なしの成功で outputPath が設定されていたら、取り出し方を直すよう促す', async () => {
    requestMock.mockResolvedValue(rawReply(204, '', {}));
    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');
    expect(r.envelope.status).toBe('error');
    expect(r.envelope.message).toContain('本文を返しませんでした');
  });

  it('本文を捨てる前に error リスナを付ける（unhandled error でプロセスを落とさない）', async () => {
    // ⚠️ destroy() だけだと Readable の 'error' が unhandled になり、
    //    api-gateway のプロセスごと落ちる（＝全 API が止まる）
    const res = rawReply(302, '', { location: 'https://example.org/' });
    requestMock.mockResolvedValue(res);

    await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    expect(res.__on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(res.__destroy).toHaveBeenCalled();
    // リスナは destroy より先に付いていること
    expect(res.__on.mock.invocationCallOrder[0]).toBeLessThan(res.__destroy.mock.invocationCallOrder[0]);
  });

  it('undici のタイムアウトを TIMEOUT に畳む（name は TimeoutError ではない）', async () => {
    requestMock.mockRejectedValue(
      Object.assign(new Error('Headers Timeout Error'), {
        name: 'HeadersTimeoutError',
        code: 'UND_ERR_HEADERS_TIMEOUT',
      }),
    );

    const r = await executeHttpCapabilityDetailed(CAP, { dealId: 'D-1' }, 'org-1');

    expect(r.envelope.error_type).toBe('TIMEOUT');
    expect(r.envelope.message).toContain('タイムアウト');
  });

  it('利用者が Content-Type を定義していても二重に送らない', async () => {
    const cap = {
      ...CAP,
      httpConfig: {
        ...CAP.httpConfig,
        method: 'POST' as const,
        headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8', secret: false }],
        bodyTemplate: { id: '{{dealId}}' },
        url: 'https://api.example.com/v1/deals',
        outputPath: '',
      },
    };
    requestMock.mockResolvedValue(reply(200, JSON.stringify({ ok: true })));

    await executeHttpCapabilityDetailed(cap, { dealId: 'D-1' }, 'org-1');

    const sent = (requestMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    const ctKeys = Object.keys(sent).filter((k) => k.toLowerCase() === 'content-type');
    expect(ctKeys).toHaveLength(1);
  });

  it('ヘッダインジェクションを試みる値は送信前に落ちる', async () => {
    const cap = {
      ...CAP,
      httpConfig: {
        ...CAP.httpConfig,
        headers: [{ name: 'X-Trace', value: 'id-{{dealId}}', secret: false }],
        url: 'https://api.example.com/v1/ping',
      },
    };

    const r = await executeHttpCapabilityDetailed(cap, { dealId: 'a\r\nX-Evil: 1' }, 'org-1');

    expect(r.envelope.error_type).toBe('VALIDATION_ERROR');
    expect(requestMock).not.toHaveBeenCalled();
  });
});
