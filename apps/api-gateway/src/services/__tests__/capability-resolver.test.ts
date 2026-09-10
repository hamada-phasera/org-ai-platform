import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  capability: { findUnique: vi.fn(), findMany: vi.fn() },
  requiredCredential: { findMany: vi.fn(), update: vi.fn() },
  capabilityGap: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  executionLog: { create: vi.fn() },
  providerConnection: { findUnique: vi.fn() },
};

vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

/** カスタム HTTP ノードは undici を直接使う（グローバル fetch のモックでは届かない）。 */
const undiciRequestMock = vi.fn();
vi.mock('undici', () => ({
  Agent: class {
    constructor(_opts?: unknown) {}
  },
  request: (...args: unknown[]) => undiciRequestMock(...args),
}));

process.env.CHANNEL_CREDENTIAL_ENC_KEY = 'c'.repeat(64);
process.env.HTTP_NODE_RATE_PER_MIN = '1000';

const { resolveAndExecute } = await import('../capability-resolver');

const SAMPLE_CAP = {
  id: 'cap-1',
  orgId: 'org-1',
  name: 'draft_email',
  displayName: 'メール下書き',
  description: 'd',
  department: 'SALES',
  status: 'ACTIVE',
  webhookPath: 'cap-draft_email',
  inputSchema: {
    type: 'object',
    required: ['recipientHint', 'purpose'],
    properties: {
      recipientHint: { type: 'string' },
      purpose: { type: 'string' },
    },
    additionalProperties: false,
  },
  requiredCreds: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAndExecute', () => {
  it('EXECUTED: name + 引数OK + creds不要 → n8n を叩いてエンベロープを返す', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(SAMPLE_CAP);
    prismaMock.requiredCredential.findMany.mockResolvedValue([]);
    prismaMock.executionLog.create.mockResolvedValue({ id: 'log-1' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 'success',
          error_type: null,
          message: 'OK',
          data: { subject: 'X', body: 'Y' },
        }),
    });

    const r = await resolveAndExecute({
      name: 'draft_email',
      args: { recipientHint: '佐藤部長', purpose: '進捗報告' },
      userId: 'u1',
      orgId: 'org-1',
    });
    expect(r.outcome).toBe('EXECUTED');
    if (r.outcome === 'EXECUTED') {
      expect(r.envelope.status).toBe('success');
      expect(r.envelope.data).toMatchObject({ subject: 'X' });
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('VALIDATION_ERROR: required 不足で n8n を叩かない', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(SAMPLE_CAP);
    prismaMock.executionLog.create.mockResolvedValue({ id: 'log-2' });
    const r = await resolveAndExecute({
      name: 'draft_email',
      args: { recipientHint: '佐藤' },
      userId: 'u1',
      orgId: 'org-1',
    });
    expect(r.outcome).toBe('VALIDATION_ERROR');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('NEEDS_AUTH: 必須 credential が DISCONNECTED', async () => {
    prismaMock.capability.findUnique.mockResolvedValue({
      ...SAMPLE_CAP,
      requiredCreds: [{ id: 'cr1', provider: 'gmail', status: 'DISCONNECTED', lastCheckedAt: new Date() }],
    });
    prismaMock.requiredCredential.findMany.mockResolvedValue([
      { id: 'cr1', provider: 'gmail', status: 'DISCONNECTED', lastCheckedAt: new Date(), capabilityId: 'cap-1' },
    ]);
    const r = await resolveAndExecute({
      name: 'draft_email',
      args: { recipientHint: 'x', purpose: 'y' },
      userId: 'u1',
      orgId: 'org-1',
    });
    expect(r.outcome).toBe('NEEDS_AUTH');
    if (r.outcome === 'NEEDS_AUTH') expect(r.missing).toContain('gmail');
  });

  it('UNSUPPORTED: name 未指定 + AI Engine が null を返す → gap が記録される', async () => {
    prismaMock.capability.findMany.mockResolvedValue([]);
    prismaMock.capabilityGap.findFirst.mockResolvedValue(null);
    prismaMock.capabilityGap.create.mockResolvedValue({
      id: 'gap-1',
      rawRequest: 'TikTokに投稿して',
      inferredName: 'post_to_tiktok',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/plan')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            capability_name: null,
            args: {},
            confidence: 0.1,
            reasoning: 'なし',
            inferred_name: 'post_to_tiktok',
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const r = await resolveAndExecute({
      rawInput: 'TikTokに投稿して',
      userId: 'u1',
      orgId: 'org-1',
    });
    expect(r.outcome).toBe('UNSUPPORTED');
    if (r.outcome === 'UNSUPPORTED') {
      expect(r.inferredName).toBe('post_to_tiktok');
      expect(r.gapId).toBe('gap-1');
    }
    expect(prismaMock.capabilityGap.create).toHaveBeenCalled();
  });

  it('EXECUTED with TIMEOUT: n8n abort で error_type=TIMEOUT', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(SAMPLE_CAP);
    prismaMock.requiredCredential.findMany.mockResolvedValue([]);
    prismaMock.executionLog.create.mockResolvedValue({ id: 'log-3' });
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const r = await resolveAndExecute({
      name: 'draft_email',
      args: { recipientHint: 'x', purpose: 'y' },
      userId: 'u1',
      orgId: 'org-1',
    });
    expect(r.outcome).toBe('EXECUTED');
    if (r.outcome === 'EXECUTED') {
      expect(r.envelope.status).toBe('error');
      expect(r.envelope.error_type).toBe('TIMEOUT');
    }
  });
});

describe('実行前確認ゲート（confidence / preview）', () => {
  it('preview モードは実行せず NEEDS_CONFIRMATION を返す', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(SAMPLE_CAP);

    const r = await resolveAndExecute({
      name: 'draft_email',
      args: { recipientHint: 'x', purpose: 'y' },
      userId: 'u1',
      orgId: 'org-1',
      mode: 'preview',
    });

    expect(r.outcome).toBe('NEEDS_CONFIRMATION');
    if (r.outcome === 'NEEDS_CONFIRMATION') {
      expect(r.capability).toBe('draft_email');
      expect(r.displayName).toBe('メール下書き');
      expect(r.args).toMatchObject({ recipientHint: 'x' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rawInput 推論の confidence が閾値未満なら実行せず確認を返す', async () => {
    prismaMock.capability.findMany.mockResolvedValue([]);
    prismaMock.capability.findUnique.mockResolvedValue(SAMPLE_CAP);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/plan')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            capability_name: 'draft_email',
            args: { recipientHint: 'x', purpose: 'y' },
            confidence: 0.3,
            reasoning: '自信なし',
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const r = await resolveAndExecute({ rawInput: 'メール書いて', userId: 'u1', orgId: 'org-1' });

    expect(r.outcome).toBe('NEEDS_CONFIRMATION');
    if (r.outcome === 'NEEDS_CONFIRMATION') expect(r.confidence).toBe(0.3);
    // /plan は呼ぶが、capability の webhook は叩かない
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('/plan'))).toBe(true);
  });

  it('confidence が閾値以上なら確認なしで実行する', async () => {
    prismaMock.capability.findMany.mockResolvedValue([]);
    prismaMock.capability.findUnique.mockResolvedValue(SAMPLE_CAP);
    prismaMock.requiredCredential.findMany.mockResolvedValue([]);
    prismaMock.executionLog.create.mockResolvedValue({ id: 'log-c' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/plan')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            capability_name: 'draft_email',
            args: { recipientHint: 'x', purpose: 'y' },
            confidence: 0.95,
            reasoning: '確信あり',
          }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) };
    });

    const r = await resolveAndExecute({ rawInput: 'メール書いて', userId: 'u1', orgId: 'org-1' });

    expect(r.outcome).toBe('EXECUTED');
  });

  it('name 明示指定はゲートを素通りする（承認後の確定実行・step-runner が無限ループしない）', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(SAMPLE_CAP);
    prismaMock.requiredCredential.findMany.mockResolvedValue([]);
    prismaMock.executionLog.create.mockResolvedValue({ id: 'log-d' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'success', error_type: null, message: '', data: {} }),
    });

    const r = await resolveAndExecute({
      name: 'draft_email',
      args: { recipientHint: 'x', purpose: 'y' },
      userId: 'u1',
      orgId: 'org-1',
    });

    expect(r.outcome).toBe('EXECUTED');
  });
});

describe('セルフサーブ接続による credential 判定', () => {
  const SLACK_CAP = {
    ...SAMPLE_CAP,
    id: 'cap-slack',
    name: 'notify_slack',
    displayName: 'Slack 投稿',
    webhookPath: 'cap-notify_slack',
    inputSchema: {
      type: 'object',
      required: ['channel', 'text'],
      properties: { channel: { type: 'string' }, text: { type: 'string' } },
      additionalProperties: false,
    },
  };

  it('ProviderConnection が無ければ NEEDS_AUTH（n8n の credential 一覧は見ない）', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(SLACK_CAP);
    prismaMock.requiredCredential.findMany.mockResolvedValue([
      { id: 'cr-s', provider: 'slack', status: 'CONNECTED', lastCheckedAt: new Date(), capabilityId: 'cap-slack' },
    ]);
    prismaMock.providerConnection.findUnique.mockResolvedValue(null);
    prismaMock.requiredCredential.update.mockResolvedValue({});

    const r = await resolveAndExecute({
      name: 'notify_slack',
      args: { channel: '#g', text: 'hi' },
      userId: 'u1',
      orgId: 'org-1',
    });

    expect(r.outcome).toBe('NEEDS_AUTH');
    // DB 上 CONNECTED でも、実際の接続が無ければ DISCONNECTED に矯正される
    expect(prismaMock.requiredCredential.update).toHaveBeenCalled();
  });
});

describe('ExecutionLog に外部APIの資格情報を残さない', () => {
  const HTTP_CAP = {
    ...SAMPLE_CAP,
    id: 'cap-http',
    name: 'refresh_partner_token',
    displayName: '取引先APIトークン更新',
    kind: 'http',
    httpConfig: {
      version: 1,
      method: 'GET',
      url: 'https://api.partner.example.com/v1/token',
      headers: [],
      bodyTemplate: null,
      outputPath: '',
      timeoutMs: 15000,
      params: [],
    },
    inputSchema: { type: 'object', required: [], properties: {}, additionalProperties: false },
    requiredCreds: [],
  };

  function undiciReply(body: string) {
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Object.assign(
        (async function* () {
          yield Buffer.from(body);
        })(),
        { destroy: vi.fn(), on: vi.fn() },
      ),
    };
  }

  it('カスタム HTTP ノードの応答本文はマスクしてから保存する', async () => {
    // ⚠️ 宛先は利用者が指定した任意の外部API。トークン更新系は平気で access_token を返すし、
    //    ExecutionLog は org のメンバーなら誰でも読める
    prismaMock.capability.findUnique.mockResolvedValue(HTTP_CAP);
    prismaMock.requiredCredential.findMany.mockResolvedValue([]);
    prismaMock.executionLog.create.mockResolvedValue({ id: 'log-http' });
    undiciRequestMock.mockResolvedValue(
      undiciReply(JSON.stringify({ access_token: 'sk-live-ABCDEFGHIJKLMNOPQRST', expires_in: 3600 })),
    );

    const r = await resolveAndExecute({
      name: 'refresh_partner_token',
      args: {},
      userId: 'u1',
      orgId: 'org-1',
    });

    expect(r.outcome).toBe('EXECUTED');
    const logged = JSON.stringify(prismaMock.executionLog.create.mock.calls.at(-1)?.[0]?.data ?? {});
    expect(logged).not.toContain('sk-live-ABCDEFGHIJKLMNOPQRST');
    expect(logged).toContain('REDACTED');
    expect(logged).toContain('3600'); // 資格情報以外は壊さない
  });

  it('自社管理の capability（n8n / native）の応答は書き換えない', async () => {
    // 宛先が自社なので、正当なデータを誤検出で壊すリスクのほうが大きい
    prismaMock.capability.findUnique.mockResolvedValue({ ...SAMPLE_CAP, kind: 'n8n' });
    prismaMock.requiredCredential.findMany.mockResolvedValue([]);
    prismaMock.executionLog.create.mockResolvedValue({ id: 'log-n8n' });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 'success',
          error_type: null,
          message: '',
          data: { hash: 'a'.repeat(48) },
        }),
    });

    await resolveAndExecute({
      name: 'draft_email',
      args: { recipientHint: 'x', purpose: 'y' },
      userId: 'u1',
      orgId: 'org-1',
    });

    const logged = JSON.stringify(prismaMock.executionLog.create.mock.calls.at(-1)?.[0]?.data ?? {});
    expect(logged).toContain('a'.repeat(48));
  });
});
