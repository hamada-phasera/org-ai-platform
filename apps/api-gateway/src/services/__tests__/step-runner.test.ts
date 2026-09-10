import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AI_ENGINE_URL = 'https://ai.test';

const prismaMock = {
  task: { update: vi.fn(), findUnique: vi.fn() },
  taskLog: { create: vi.fn() },
  agent: { findUnique: vi.fn() },
  capability: { findUnique: vi.fn() },
  organization: { findUnique: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const resolveMock = vi.fn();
vi.mock('../capability-resolver', () => ({ resolveAndExecute: resolveMock }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { renderArgTemplate, requiresApproval, initRunState, parseRunState, runAgentTask, resumeAgentTask } =
  await import('../step-runner');

const AGENT = {
  id: 'A1',
  instructions: 'あなたは分析AIです',
  department: 'ANALYTICS',
  createdBy: 'u1',
  steps: [
    { capabilityName: 'create_google_doc', argTemplate: { title: '日報', content: '{{input}}' } },
    { capabilityName: 'notify_slack', argTemplate: { channel: '#general', text: '{{prev}}' } },
  ],
};

/** Task.update に渡された最後のデータを取る */
function lastUpdateData(): Record<string, unknown> {
  const calls = prismaMock.task.update.mock.calls;
  return calls[calls.length - 1][0].data;
}
function updateDataMatching(predicate: (d: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  for (const call of [...prismaMock.task.update.mock.calls].reverse()) {
    if (predicate(call[0].data)) return call[0].data;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.task.update.mockResolvedValue({});
  prismaMock.taskLog.create.mockResolvedValue({ id: 'l' });
  prismaMock.organization.findUnique.mockResolvedValue({ plan: 'STARTER' });
  prismaMock.capability.findUnique.mockResolvedValue({ displayName: 'Slack 投稿' });
});

describe('renderArgTemplate', () => {
  it('{{input}} と {{prev}} を置換する（空白ありも可）', () => {
    const out = renderArgTemplate(
      { a: '{{input}}', b: '前: {{ prev }}', c: '{{input}}/{{prev}}' },
      { input: 'IN', prev: 'PREV' },
    );
    expect(out).toEqual({ a: 'IN', b: '前: PREV', c: 'IN/PREV' });
  });

  it('未知のプレースホルダは置換しない（勝手に解釈しない）', () => {
    const out = renderArgTemplate({ a: '{{foo}}', b: '{{ output }}' }, { input: 'IN', prev: 'P' });
    expect(out).toEqual({ a: '{{foo}}', b: '{{ output }}' });
  });
});

describe('requiresApproval', () => {
  it('外部送信 capability は承認が必要', () => {
    expect(requiresApproval('notify_slack')).toBe(true);
    expect(requiresApproval('send_email')).toBe(true);
    expect(requiresApproval('post_to_x')).toBe(true);
  });
  it('成果物作成系は承認不要（外部に出ない）', () => {
    expect(requiresApproval('create_google_doc')).toBe(false);
    expect(requiresApproval('llm_transform')).toBe(false);
  });
});

describe('initRunState / parseRunState', () => {
  it('全ステップ PENDING で初期化される', () => {
    const s = initRunState('やって', AGENT.steps);
    expect(s.version).toBe(1);
    expect(s.currentIndex).toBe(0);
    expect(s.steps.map((x) => x.status)).toEqual(['PENDING', 'PENDING']);
  });
  it('parseRunState は不正 JSON / 旧形式に対し null', () => {
    expect(parseRunState(null)).toBeNull();
    expect(parseRunState('{')).toBeNull();
    expect(parseRunState(JSON.stringify({ version: 99 }))).toBeNull();
    expect(parseRunState(JSON.stringify(initRunState('x', AGENT.steps)))?.version).toBe(1);
  });
});

describe('runAgentTask', () => {
  it('承認対象 capability の手前で PENDING_APPROVAL にして止まる（送信しない）', async () => {
    resolveMock.mockResolvedValue({
      outcome: 'EXECUTED',
      capability: 'create_google_doc',
      envelope: { status: 'success', error_type: null, message: '', data: { url: 'https://doc' } },
      executionLogId: 'log1',
    });

    await runAgentTask({ id: 't1', orgId: 'org-1', input: '売上まとめ' }, AGENT);

    // step1 は実行された、step2 (notify_slack) は実行されていない
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0][0].name).toBe('create_google_doc');

    const pending = updateDataMatching((d) => d.status === 'PENDING_APPROVAL');
    expect(pending).not.toBeNull();
    const approval = JSON.parse(String(pending!.approvalData));
    expect(approval.kind).toBe('agent_step');
    expect(approval.capabilityName).toBe('notify_slack');
    expect(approval.stepIndex).toBe(1);
    // {{prev}} に step1 の出力が入っている
    expect(approval.args.text).toContain('https://doc');
  });

  it('ステップ失敗で Task を FAILED にし、後続を実行しない', async () => {
    resolveMock.mockResolvedValue({
      outcome: 'NEEDS_AUTH',
      capability: 'create_google_doc',
      missing: ['googledocs'],
    });

    await runAgentTask({ id: 't1', orgId: 'org-1', input: 'x' }, AGENT);

    expect(resolveMock).toHaveBeenCalledTimes(1);
    const failed = updateDataMatching((d) => d.status === 'FAILED');
    expect(failed).not.toBeNull();
    expect(String(failed!.lastError)).toContain('step 1');
    expect(String(failed!.lastError)).toContain('googledocs');
  });

  it('llm_transform は capability を通さず AI Engine /llm/chat を呼ぶ', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: '要約しました' }) });
    const agent = {
      ...AGENT,
      steps: [{ capabilityName: 'llm_transform', argTemplate: { prompt: '{{input}} を要約' } }],
    };

    await runAgentTask({ id: 't2', orgId: 'org-1', input: '長文' }, agent);

    expect(resolveMock).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/llm/chat');
    const done = updateDataMatching((d) => d.status === 'DONE');
    expect(done?.output).toBe('要約しました');
  });

  it('全ステップ完了で DONE + 最終出力を output に入れる', async () => {
    const agent = { ...AGENT, steps: [AGENT.steps[0]] };
    resolveMock.mockResolvedValue({
      outcome: 'EXECUTED',
      capability: 'create_google_doc',
      envelope: { status: 'success', error_type: null, message: '', data: { url: 'https://doc' } },
      executionLogId: 'log1',
    });

    await runAgentTask({ id: 't3', orgId: 'org-1', input: 'x' }, agent);

    const done = updateDataMatching((d) => d.status === 'DONE');
    expect(done).not.toBeNull();
    expect(String(done!.output)).toContain('https://doc');
  });
});

describe('resumeAgentTask', () => {
  it('editedArgs を反映して承認ステップを実行し、残りを継続する', async () => {
    const state = initRunState('売上まとめ', AGENT.steps);
    state.currentIndex = 1;
    state.steps[0] = { ...state.steps[0], status: 'DONE', output: 'https://doc' };
    state.steps[1] = { ...state.steps[1], status: 'AWAITING_APPROVAL', args: { channel: '#general', text: '元の本文' } };

    prismaMock.task.findUnique.mockResolvedValue({
      id: 't1',
      orgId: 'org-1',
      agentId: 'A1',
      executionResult: JSON.stringify(state),
      approvalData: JSON.stringify({
        kind: 'agent_step',
        stepIndex: 1,
        capabilityName: 'notify_slack',
        capabilityLabel: 'Slack 投稿',
        args: { channel: '#general', text: '元の本文' },
      }),
    });
    prismaMock.agent.findUnique.mockResolvedValue({
      id: 'A1',
      instructions: AGENT.instructions,
      department: AGENT.department,
      createdBy: AGENT.createdBy,
      steps: AGENT.steps,
    });
    resolveMock.mockResolvedValue({
      outcome: 'EXECUTED',
      capability: 'notify_slack',
      envelope: { status: 'success', error_type: null, message: '投稿しました', data: { ts: '1' } },
      executionLogId: 'log2',
    });

    await resumeAgentTask('t1', { editedArgs: { channel: '#general', text: '人が直した本文' } });

    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0][0].args.text).toBe('人が直した本文');
    const done = updateDataMatching((d) => d.status === 'DONE');
    expect(done).not.toBeNull();
  });

  it('エージェントが削除済みなら FAILED にする', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      id: 't1',
      orgId: 'org-1',
      agentId: 'A1',
      executionResult: null,
      approvalData: null,
    });
    prismaMock.agent.findUnique.mockResolvedValue(null);

    await resumeAgentTask('t1');

    expect(lastUpdateData().status).toBe('FAILED');
  });
});
