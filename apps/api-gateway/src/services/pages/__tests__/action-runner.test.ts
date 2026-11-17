import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PAGE_RESPONSE_MAX_BYTES, buildPageHookUrl, callPageHook } from '../action-runner';
import { PAGE_ORG_THROTTLE, resetOrgThrottle, takeOrgActionSlot } from '../org-throttle';
import { SAMPLE_SUBMIT_MESSAGE, isSamplePage, sampleQueryResponse } from '../sample';

// action-runner の n8n 呼び出し（docs/design/custom-pages.md §5.2 の 9・T2・T3・T8）。fetch はモック（外部通信なし）。

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

const SAVED = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  process.env.N8N_WEBHOOK_AUTH_TOKEN = 'shared-token-for-test';
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...SAVED };
});

describe('buildPageHookUrl（K2: pages/<orgId>/<hook> 以外にならない）', () => {
  it('ベースの末尾スラッシュを除き、pages/<orgId>/<hook> に組み立てる', () => {
    expect(buildPageHookUrl('https://n8n.test///', 'org-A', 'inquiries-list')).toBe('https://n8n.test/webhook/pages/org-A/inquiries-list');
  });
  it('orgId はエンコードする', () => {
    expect(buildPageHookUrl('https://n8n.test', 'a/b?c', 'x')).toBe('https://n8n.test/webhook/pages/a%2Fb%3Fc/x');
  });
  it.each(['../dept-sales', 'a/b', 'a.b', '%2f', 'http://evil', 'A', '', '-x'])('不正な hook %j は投げる', (hook) => {
    expect(() => buildPageHookUrl('https://n8n.test', 'org-A', hook)).toThrow();
  });
  it('orgId が空なら投げる', () => {
    expect(() => buildPageHookUrl('https://n8n.test', '', 'x')).toThrow();
  });
});

describe('callPageHook', () => {
  const url = 'https://n8n.test/webhook/pages/org-A/h';

  it('POST・共有トークン・JSON・リダイレクトを追わない', async () => {
    fetchMock.mockResolvedValue(json({ open: 1 }));
    const res = await callPageHook({ url, body: { orgId: 'org-A' }, retryOnConnectionError: false });
    expect(res).toMatchObject({ ok: true, json: { open: 1 } });
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['x-org-ai-token']).toBe('shared-token-for-test');
    expect(JSON.parse(init.body as string)).toEqual({ orgId: 'org-A' });
  });

  it('非 2xx は FAILED', async () => {
    fetchMock.mockResolvedValue(json({ message: 'n8n internal detail' }, { status: 500 }));
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: true })).toMatchObject({ ok: false, reason: 'FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // HTTP のエラーはやり直さない
  });

  it('JSON でない Content-Type は INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: false })).toMatchObject({ ok: false, reason: 'INVALID_RESPONSE' });
  });

  it('JSON として読めなければ INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValue(new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: false })).toMatchObject({ ok: false, reason: 'INVALID_RESPONSE' });
  });

  it('256KB を超えたら読むのをやめて INVALID_RESPONSE（Content-Length が無くても）', async () => {
    const big = JSON.stringify({ rows: 'x'.repeat(PAGE_RESPONSE_MAX_BYTES) });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(big);
        for (let i = 0; i < bytes.length; i += 16 * 1024) c.enqueue(bytes.slice(i, i + 16 * 1024));
        c.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: false })).toMatchObject({ ok: false, reason: 'INVALID_RESPONSE' });
  });

  it('Content-Length が 256KB を超えると宣言していれば読まない', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(PAGE_RESPONSE_MAX_BYTES + 1) } }),
    );
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: false })).toMatchObject({ ok: false, reason: 'INVALID_RESPONSE' });
  });

  it('タイムアウトは TIMEOUT（やり直さない）', async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const res = await callPageHook({ url, body: {}, retryOnConnectionError: true, timeoutMs: 20 });
    expect(res).toMatchObject({ ok: false, reason: 'TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('接続エラーは query（retry あり）だけ 1 回やり直す', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json({ ok: true }));
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: true })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('submit（retry なし）は接続エラーでやり直さない', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: false })).toMatchObject({ ok: false, reason: 'FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('やり直しは 1 回まで', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await callPageHook({ url, body: {}, retryOnConnectionError: true })).toMatchObject({ ok: false, reason: 'FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('org-throttle（組織ごとの窓）', () => {
  beforeEach(() => resetOrgThrottle());

  it('submit は 1 分 30 回、query は 120 回。組織と種類で別に数え、窓が明けたら戻る', () => {
    const t = 1_000_000;
    for (let i = 0; i < PAGE_ORG_THROTTLE.submit; i++) expect(takeOrgActionSlot('org-A', 'submit', t)).toBe(true);
    expect(takeOrgActionSlot('org-A', 'submit', t)).toBe(false);
    expect(takeOrgActionSlot('org-B', 'submit', t)).toBe(true);
    expect(takeOrgActionSlot('org-A', 'query', t)).toBe(true);
    expect(takeOrgActionSlot('org-A', 'submit', t + PAGE_ORG_THROTTLE.windowMs)).toBe(true);

    for (let i = 1; i < PAGE_ORG_THROTTLE.query; i++) expect(takeOrgActionSlot('org-A', 'query', t)).toBe(true);
    expect(takeOrgActionSlot('org-A', 'query', t)).toBe(false);
  });
});

describe('sample（本番では無効。T16）', () => {
  const page = { sampleData: { list: { open: 3 } } };

  it('PAGES_SAMPLE_MODE=true かつ sampleData があるときだけ', () => {
    expect(isSamplePage(page)).toBe(false);
    process.env.PAGES_SAMPLE_MODE = 'true';
    expect(isSamplePage(page)).toBe(true);
    expect(isSamplePage({ sampleData: null })).toBe(false);
    expect(isSamplePage({ sampleData: [1] })).toBe(false);
  });

  it('本番では PAGES_SAMPLE_MODE=true でも無効', () => {
    process.env.PAGES_SAMPLE_MODE = 'true';
    process.env.NODE_ENV = 'production';
    expect(isSamplePage(page)).toBe(false);
  });

  it('action の分だけを返す（無ければ undefined）', () => {
    expect(sampleQueryResponse(page, 'list')).toEqual({ open: 3 });
    expect(sampleQueryResponse(page, 'other')).toBeUndefined();
    expect(sampleQueryResponse(page, 'toString')).toBeUndefined();
    expect(SAMPLE_SUBMIT_MESSAGE).toContain('サンプル');
  });
});
