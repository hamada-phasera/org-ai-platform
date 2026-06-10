import { describe, it, expect, vi, beforeEach } from 'vitest';

// 環境変数は import より前に設定する（モジュール読み込み時に読まれるため）
process.env.N8N_CLOUD_URL = 'https://n8n.test';
process.env.N8N_API_KEY = 'test-key';
process.env.N8N_WEBHOOK_AUTH_TOKEN = 'tok';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { buildAgentWorkflowJson, createAgentWorkflow, agentWebhookPath, agentWorkflowName } =
  await import('../n8n-workflow-builder');

const AGENT = {
  id: 'abc123',
  name: '週次レポート',
  department: 'SALES',
  // バッククォート・引用符・改行を含む instructions が安全に埋め込まれるか
  instructions: 'あなたは営業アシスタント。`code` と "quote" と\n改行を含む。',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAgentWorkflowJson', () => {
  it('name / webhook path / headerAuth / instructions を正しく構築する', () => {
    const wf = buildAgentWorkflowJson(AGENT) as {
      name: string;
      nodes: { name: string; type: string; parameters: Record<string, unknown> }[];
    };
    expect(wf.name).toBe('org-ai Agent abc123');

    const webhook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook')!;
    expect(webhook.parameters.path).toBe('agent-abc123');
    expect(webhook.parameters.authentication).toBe('headerAuth');

    const build = wf.nodes.find((n) => n.name === 'Build Prompt')!;
    // JSON.stringify 済みの文字列リテラルがそのまま jsCode に含まれる（エスケープ安全）
    expect(build.parameters.jsCode as string).toContain(JSON.stringify(AGENT.instructions));

    expect(agentWebhookPath('x')).toBe('agent-x');
    expect(agentWorkflowName('x')).toBe('org-ai Agent x');
  });
});

describe('createAgentWorkflow', () => {
  it('ACTIVE: credential 作成 → workflow 作成 → activate 成功', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/v1/credentials') && method === 'GET')
        return { ok: true, json: async () => ({ data: [] }) };
      if (url.endsWith('/api/v1/credentials') && method === 'POST')
        return { ok: true, json: async () => ({ data: { id: 'cred-1' } }) };
      if (url.endsWith('/api/v1/workflows') && method === 'POST')
        return { ok: true, json: async () => ({ data: { id: 'wf-1' } }), text: async () => '' };
      if (url.includes('/activate')) return { ok: true };
      throw new Error(`unexpected ${method} ${url}`);
    });

    const r = await createAgentWorkflow(AGENT);
    expect(r.workflowId).toBe('wf-1');
    expect(r.webhookPath).toBe('agent-abc123');
    expect(r.active).toBe(true);
  });

  it('n8n 不達なら throw する（呼び出し側で n8nStatus=PENDING にできる）', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(createAgentWorkflow(AGENT)).rejects.toThrow();
  });
});
