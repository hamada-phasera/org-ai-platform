import { describe, it, expect, vi, beforeEach } from 'vitest';

// N8N_API_KEY 未設定 → isWebhookAvailableByName はネットワーク無しで true 扱い
delete process.env.N8N_API_KEY;
process.env.N8N_URL = 'https://n8n.test';
process.env.AI_ENGINE_URL = 'https://ai.test';
process.env.API_GATEWAY_URL = 'https://gw.test';

const prismaMock = {
  organization: { findUnique: vi.fn() },
  task: { update: vi.fn() },
  taskLog: { create: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { dispatchAgentTask } = await import('../task-executor');

const TASK = { id: 't1', orgId: 'org-1', title: 'T', input: 'やって', taskType: 'agent' };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER' });
  prismaMock.taskLog.create.mockResolvedValue({ id: 'l' });
  prismaMock.task.update.mockResolvedValue({});
});

describe('dispatchAgentTask', () => {
  it('ACTIVE + webhook 利用可 → n8n webhook を叩き、AI Engine は呼ばず Task も更新しない', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/webhook/agent-A1')) return { ok: true, text: async () => '' };
      throw new Error(`unexpected ${url}`);
    });

    await dispatchAgentTask(TASK, {
      id: 'A1',
      instructions: 'sys',
      department: 'SALES',
      webhookPath: 'agent-A1',
      n8nStatus: 'ACTIVE',
    });

    const calledWebhook = fetchMock.mock.calls.some((c) => String(c[0]).includes('/webhook/agent-A1'));
    const calledLlm = fetchMock.mock.calls.some((c) => String(c[0]).includes('/llm/chat'));
    expect(calledWebhook).toBe(true);
    // 受理は n8n コールバックが完了処理するため、ここでは AI Engine も Task 更新も呼ばれない
    expect(calledLlm).toBe(false);
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it('n8nStatus=PENDING → AI Engine フォールバックで実行し Task を DONE に更新', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/llm/chat')) return { ok: true, json: async () => ({ content: '完了レポート' }) };
      throw new Error(`unexpected ${url}`);
    });

    await dispatchAgentTask(TASK, {
      id: 'A2',
      instructions: 'sys',
      department: 'SALES',
      webhookPath: null,
      n8nStatus: 'PENDING',
    });

    const calledLlm = fetchMock.mock.calls.some((c) => String(c[0]).includes('/llm/chat'));
    expect(calledLlm).toBe(true);
    expect(prismaMock.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DONE', output: '完了レポート' }) }),
    );
  });
});
