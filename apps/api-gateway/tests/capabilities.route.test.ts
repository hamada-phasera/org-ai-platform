import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.CHANNEL_CREDENTIAL_ENC_KEY = 'c'.repeat(64);

const prismaMock = {
  capability: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  agent: { findMany: vi.fn() },
  capabilityGap: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  executionLog: { findMany: vi.fn(), create: vi.fn() },
  requiredCredential: { findMany: vi.fn(), update: vi.fn() },
  providerConnection: { findUnique: vi.fn() },
};
vi.mock('../src/utils/prisma', () => ({ prisma: prismaMock }));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireOwner: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
  requireAdmin: async (req: { user?: unknown }) => {
    req.user = { orgId: 'org-1', sub: 'user-1', role: 'OWNER' };
  },
}));

/** 外部送信は起きないはずのケースを検証するため undici をモックしておく */
const requestMock = vi.fn();
vi.mock('undici', () => ({
  Agent: class {
    constructor(_o?: unknown) {}
  },
  request: (...a: unknown[]) => requestMock(...a),
}));

const { capabilityRoutes } = await import('../src/routes/capabilities');
const { sealSecret } = await import('../src/services/secret-box');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(capabilityRoutes, { prefix: '/api/capabilities' });
  return app;
}

const VALID_BODY = {
  name: 'fetch_crm_deal',
  displayName: 'CRMから商談を取得',
  description: 'CRM の商談IDを渡すと金額と担当者を返す。営業部の日次報告で使う。',
  department: 'SALES',
  params: [{ name: 'dealId', type: 'string', required: true }],
  http: {
    method: 'GET',
    url: 'https://api.example.com/v1/deals/{{dealId}}',
    headers: [{ name: 'Authorization', value: 'Bearer sk-live-REALKEY', secret: true }],
    outputPath: 'data',
  },
};

const STORED_CAP = {
  id: 'cap-1',
  orgId: 'org-1',
  name: 'fetch_crm_deal',
  displayName: 'CRMから商談を取得',
  description: 'desc',
  department: 'SALES',
  inputSchema: {},
  status: 'ACTIVE',
  webhookPath: null,
  kind: 'http',
  createdBy: 'user-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  httpConfig: {
    version: 1,
    method: 'GET',
    url: 'https://api.example.com/v1/deals/{{dealId}}',
    headers: [{ name: 'Authorization', value: sealSecret('Bearer sk-live-REALKEY'), secret: true }],
    bodyTemplate: null,
    outputPath: 'data',
    timeoutMs: 15000,
    params: [{ name: 'dealId', type: 'string', required: true }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.capability.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...STORED_CAP,
    ...data,
  }));
  prismaMock.agent.findMany.mockResolvedValue([]);
});

describe('POST /api/capabilities（カスタムノード作成）', () => {
  it('作成できる。API キーは暗号文で保存され、レスポンスには出ない', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/capabilities', payload: VALID_BODY });

    expect(res.statusCode).toBe(201);
    const saved = prismaMock.capability.create.mock.calls[0][0].data;
    const header = (saved.httpConfig as { headers: { value: string }[] }).headers[0];
    expect(header.value.startsWith('v1:')).toBe(true); // seal されている
    expect(header.value).not.toContain('sk-live-REALKEY');

    // レスポンスに平文も暗号文も出ない
    expect(res.body).not.toContain('sk-live-REALKEY');
    expect(res.body).not.toContain('v1:');
    expect(JSON.parse(res.body).data.httpConfig.headers[0].value).toBe('••••••');

    // 保存時に外部へリクエストしない（blind request プリミティブにしない）
    expect(requestMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('inputSchema は params から自動生成される', async () => {
    const app = await build();
    await app.inject({ method: 'POST', url: '/api/capabilities', payload: VALID_BODY });
    const saved = prismaMock.capability.create.mock.calls[0][0].data;
    expect(saved.inputSchema).toEqual({
      type: 'object',
      required: ['dealId'],
      properties: { dealId: { type: 'string' } },
      additionalProperties: false,
    });
    await app.close();
  });

  it('URL に使われている param は required でなくても必須に昇格する', async () => {
    // ⚠️ required:false のまま保存すると、実行時に必ず TemplateError で落ちる
    //    （保存はできるが一度も動かないノードができる）。planner は optional と判断しがち
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities',
      payload: {
        ...VALID_BODY,
        params: [{ name: 'dealId', type: 'string', required: false }],
      },
    });
    expect(res.statusCode).toBe(201);

    const saved = prismaMock.capability.create.mock.calls[0][0].data;
    expect(saved.httpConfig.params[0].required).toBe(true);
    // inputSchema も昇格後の params から作られていること（planner が省略できてしまわない）
    expect(saved.inputSchema.required).toEqual(['dealId']);
    await app.close();
  });

  it('予約名は拒否する', async () => {
    const app = await build();
    for (const name of ['notify_slack', 'send_email', 'llm_transform', 'create_google_doc']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/capabilities',
        payload: { ...VALID_BODY, name },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('RESERVED_NAME');
    }
    await app.close();
  });

  it('危険な URL は保存を拒否する', async () => {
    const app = await build();
    const cases = [
      'http://api.example.com/x',
      'https://user:pass@api.example.com/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://{{host}}.example.com/x',
      'https://api.example.com:22/x',
    ];
    for (const url of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/capabilities',
        payload: { ...VALID_BODY, http: { ...VALID_BODY.http, url } },
      });
      expect(res.statusCode, `${url} は拒否されるべき`).toBe(400);
    }
    expect(prismaMock.capability.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('宣言されていないパラメータを使う URL は拒否する', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities',
      payload: {
        ...VALID_BODY,
        http: { ...VALID_BODY.http, url: 'https://api.example.com/{{undeclared}}' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('UNDECLARED_PARAM');
    await app.close();
  });

  it('送信側が制御すべきヘッダは拒否する', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities',
      payload: {
        ...VALID_BODY,
        http: { ...VALID_BODY.http, headers: [{ name: 'Host', value: 'evil.com' }] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN_HEADER');
    await app.close();
  });

  it('事前に封緘された値は拒否する（他 org の暗号文を持ち込ませない）', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities',
      payload: {
        ...VALID_BODY,
        http: {
          ...VALID_BODY.http,
          headers: [{ name: 'Authorization', value: 'v1:aaa:bbb:ccc', secret: true }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('SEALED_VALUE_NOT_ALLOWED');
    await app.close();
  });

  it('伏字がそのまま送り返されたら拒否する', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities',
      payload: {
        ...VALID_BODY,
        http: {
          ...VALID_BODY.http,
          headers: [{ name: 'Authorization', value: '••••••', secret: true }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('MASKED_VALUE_NOT_ALLOWED');
    await app.close();
  });

  it('名前が重複したら 409', async () => {
    prismaMock.capability.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/capabilities', payload: VALID_BODY });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe('GET /api/capabilities（既存の生返しバグの回帰）', () => {
  it('secret ヘッダを伏字にして返す', async () => {
    prismaMock.capability.findMany.mockResolvedValue([{ ...STORED_CAP, requiredCreds: [] }]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('v1:');
    expect(res.body).not.toContain('sk-live-REALKEY');
    expect(JSON.parse(res.body).data[0].httpConfig.headers[0].value).toBe('••••••');
    await app.close();
  });
});

describe('DELETE /api/capabilities/:id', () => {
  it('標準の機能は削除できない', async () => {
    prismaMock.capability.findUnique.mockResolvedValue({ ...STORED_CAP, kind: 'n8n' });
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/capabilities/cap-1' });
    expect(res.statusCode).toBe(403);
    expect(prismaMock.capability.delete).not.toHaveBeenCalled();
    await app.close();
  });

  it('使っているエージェントがあれば 409 で知らせる', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(STORED_CAP);
    prismaMock.agent.findMany.mockResolvedValue([
      { id: 'a1', name: '朝の報告', steps: [{ capabilityName: 'fetch_crm_deal' }] },
    ]);
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/capabilities/cap-1' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.agents[0].name).toBe('朝の報告');
    await app.close();
  });

  it('force=true なら参照があっても消せる', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(STORED_CAP);
    prismaMock.agent.findMany.mockResolvedValue([
      { id: 'a1', name: '朝の報告', steps: [{ capabilityName: 'fetch_crm_deal' }] },
    ]);
    prismaMock.capability.delete.mockResolvedValue({});
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/capabilities/cap-1?force=true' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('他 org のものは 404', async () => {
    prismaMock.capability.findUnique.mockResolvedValue({ ...STORED_CAP, orgId: 'other' });
    const app = await build();
    const res = await app.inject({ method: 'DELETE', url: '/api/capabilities/cap-1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PATCH /api/capabilities/:id', () => {
  it('kind と name は変更できない（seed 行を http にして消す経路を塞ぐ）', async () => {
    prismaMock.capability.findUnique.mockResolvedValue({ ...STORED_CAP, kind: 'n8n' });
    prismaMock.capability.update.mockResolvedValue({ ...STORED_CAP, kind: 'n8n' });
    const app = await build();
    await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/cap-1',
      payload: { kind: 'http', name: 'hacked', displayName: '変更' },
    });
    const data = prismaMock.capability.update.mock.calls[0][0].data;
    expect(data.kind).toBeUndefined();
    expect(data.name).toBeUndefined();
    expect(data.displayName).toBe('変更');
    await app.close();
  });

  it('標準の機能に接続設定は付けられない', async () => {
    prismaMock.capability.findUnique.mockResolvedValue({ ...STORED_CAP, kind: 'n8n' });
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/cap-1',
      payload: { http: { method: 'GET', url: 'https://api.example.com/x', headers: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('NOT_CUSTOM_NODE');
    await app.close();
  });

  it('secret ヘッダの value 省略で既存の鍵を据え置く', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(STORED_CAP);
    prismaMock.capability.update.mockResolvedValue(STORED_CAP);
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/capabilities/cap-1',
      payload: {
        params: [{ name: 'dealId', type: 'string', required: true }],
        http: {
          method: 'GET',
          url: 'https://api.example.com/v2/deals/{{dealId}}',
          headers: [{ name: 'Authorization', secret: true }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const saved = prismaMock.capability.update.mock.calls[0][0].data;
    const header = (saved.httpConfig as { headers: { value: string }[] }).headers[0];
    expect(header.value).toBe(STORED_CAP.httpConfig.headers[0].value); // 据え置き
    await app.close();
  });
});

describe('POST /api/capabilities/:id/test', () => {
  it('書き込み系は confirmWrite なしで拒否（実送信を誤爆させない）', async () => {
    prismaMock.capability.findUnique.mockResolvedValue({
      ...STORED_CAP,
      httpConfig: { ...STORED_CAP.httpConfig, method: 'POST' },
    });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/capabilities/cap-1/test', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('CONFIRM_WRITE_REQUIRED');
    expect(requestMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('テストは ExecutionLog に書かない（実行履歴ではない）', async () => {
    prismaMock.capability.findUnique.mockResolvedValue(STORED_CAP);
    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Object.assign(
        (async function* () {
          yield Buffer.from(JSON.stringify({ data: 'ok' }));
        })(),
        { destroy: vi.fn() },
      ),
    });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/capabilities/cap-1/test',
      payload: { args: { dealId: 'D-1' } },
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.executionLog.create).not.toHaveBeenCalled();
    // 展開後 URL とヘッダを返さない
    expect(res.body).not.toContain('D-1');
    expect(res.body).not.toContain('sk-live-REALKEY');
    await app.close();
  });
});
