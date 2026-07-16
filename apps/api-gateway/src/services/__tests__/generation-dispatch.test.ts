import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.AI_ENGINE_URL = 'https://ai.test';

const prismaMock = {
  organization: { findUnique: vi.fn() },
  task: { findUnique: vi.fn(), update: vi.fn() },
  taskLog: { create: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

// n8n 経路のプリミティブをモック（利用可否と webhook 受理を制御する）
const availableMock = vi.fn();
const triggerMock = vi.fn();
vi.mock('../task-executor', () => ({
  isWebhookAvailableByName: availableMock,
  triggerN8nWorkflowByPath: triggerMock,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { dispatchGenerationTask, finalizeGenerationOutput, GENERATION_WORKFLOWS } = await import(
  '../generation-dispatch'
);

const TASK = {
  id: 'task-1',
  orgId: 'org-1',
  title: 'SNS下書き(twitter): テスト',
  input: JSON.stringify({ platform: 'twitter', topic: 'テスト' }),
  department: 'MARKETING',
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER' });
  prismaMock.task.findUnique.mockResolvedValue({ ...TASK, taskType: 'sns', output: null });
  prismaMock.task.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'task-1',
    ...data,
  }));
  prismaMock.taskLog.create.mockResolvedValue({ id: 'log-1' });
});

describe('finalizeGenerationOutput', () => {
  it('sns: JSON 応答をドラフトに整形し PENDING_APPROVAL に遷移（DONE にしない = 投稿されない）', async () => {
    await finalizeGenerationOutput(
      'task-1',
      'sns',
      JSON.stringify({ content: '新サービスを公開しました！', hashtags: ['ai', '#tech'] }),
    );
    const data = prismaMock.task.update.mock.calls[0][0].data;
    expect(data.status).toBe('PENDING_APPROVAL');
    const out = JSON.parse(data.output);
    expect(out.platform).toBe('twitter');
    expect(out.content).toContain('新サービス');
    expect(out.hashtags).toEqual(['ai', 'tech']); // '#tech' は整形されて 'tech'
    expect(out.validation.ok).toBe(true);
  });

  it('sns: 非JSON応答は全文を本文にフォールバック', async () => {
    await finalizeGenerationOutput('task-1', 'sns', 'ただのテキスト応答（JSONではない）');
    const out = JSON.parse(prismaMock.task.update.mock.calls[0][0].data.output);
    expect(out.content).toContain('ただのテキスト応答');
    expect(out.hashtags).toEqual([]);
  });

  it('proposal: output を {proposal, templateId} に整形し DONE', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      id: 'task-1',
      taskType: 'proposal',
      input: JSON.stringify({ templateId: 'standard', customerName: 'A社' }),
    });
    await finalizeGenerationOutput('task-1', 'proposal', '## 提案\n本文です。', { model: 'claude-sonnet-5' });
    const data = prismaMock.task.update.mock.calls[0][0].data;
    expect(data.status).toBe('DONE');
    const out = JSON.parse(data.output);
    expect(out.proposal).toContain('本文です');
    expect(out.templateId).toBe('standard');
    expect(out.model).toBe('claude-sonnet-5');
  });

  it('エッジ: 空の生成結果は FAILED として記録する', async () => {
    await finalizeGenerationOutput('task-1', 'sns', '   ');
    const data = prismaMock.task.update.mock.calls[0][0].data;
    expect(data.status).toBe('FAILED');
    expect(data.lastError).toContain('空');
  });
});

describe('dispatchGenerationTask', () => {
  it('n8n WF がアクティブ & webhook 受理 → n8n に委譲し AI Engine は呼ばない', async () => {
    availableMock.mockResolvedValue(true);
    triggerMock.mockResolvedValue(true);
    await dispatchGenerationTask(TASK, {
      taskType: 'sns',
      systemPrompt: 'sys',
      userPrompt: 'user',
      jsonMode: true,
    });
    expect(availableMock).toHaveBeenCalledWith(GENERATION_WORKFLOWS.sns.workflowName);
    expect(triggerMock).toHaveBeenCalledTimes(1);
    const [path, task, systemPrompt, steps, opts] = triggerMock.mock.calls[0];
    expect(path).toBe('sns-draft');
    expect(task.taskType).toBe('sns');
    expect(systemPrompt).toBe('sys');
    expect(steps).toBeUndefined();
    expect(opts).toMatchObject({ userPrompt: 'user', jsonMode: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('n8n 不達 → AI Engine /llm/chat にフォールバックし finalize まで完了する', async () => {
    availableMock.mockResolvedValue(true);
    triggerMock.mockResolvedValue(false); // webhook 不達
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: JSON.stringify({ content: '本文', hashtags: [] }), model: 'gemini-2.5-flash' }),
    });
    await dispatchGenerationTask(TASK, {
      taskType: 'sns',
      systemPrompt: 'sys',
      userPrompt: 'user',
      jsonMode: true,
      userEmail: 'boss@example.com',
    });
    // /llm/chat に json_mode / user_email 付きで到達
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/llm/chat');
    const body = JSON.parse(opts.body);
    expect(body.json_mode).toBe(true);
    expect(body.user_email).toBe('boss@example.com');
    expect(body.department).toBe('MARKETING');
    // finalize: PENDING_APPROVAL へ
    const statuses = prismaMock.task.update.mock.calls.map((c) => c[0].data.status).filter(Boolean);
    expect(statuses).toContain('PENDING_APPROVAL');
  });

  it('AI Engine もエラー → FAILED を記録する', async () => {
    availableMock.mockResolvedValue(false);
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await dispatchGenerationTask(TASK, {
      taskType: 'proposal',
      systemPrompt: 'sys',
      userPrompt: 'user',
      jsonMode: false,
    });
    const statuses = prismaMock.task.update.mock.calls.map((c) => c[0].data.status).filter(Boolean);
    expect(statuses).toContain('FAILED');
  });
});
