import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.AI_ENGINE_URL = 'https://ai.test';

const prismaMock = {
  task: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
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

const {
  renderArgTemplate,
  coerceJsonLike,
  looksLikeJsonTemplate,
  requiresApproval,
  initRunState,
  parseRunState,
  runAgentTask,
  resumeAgentTask,
  recoverStaleRunningTasks,
  STALE_RUNNING_MESSAGE,
} = await import('../step-runner');

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
  prismaMock.task.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.task.findMany.mockResolvedValue([]);
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

  it('string 以外の値（配列・オブジェクト・数値）を壊さずそのまま通す', () => {
    // AI 推論で作られた steps は zod を通らないので実配列が入りうる。
    // 以前は value.replace で TypeError になり run 全体が落ちていた。
    const out = renderArgTemplate(
      {
        title: '{{input}}',
        headers: ['日付', '売上'],
        rows: [['1/1', 100]],
        slides: [{ title: 'A', body: 'B' }],
        count: 3,
        flag: true,
        nothing: null,
      },
      { input: 'IN', prev: 'P' },
    );
    expect(out).toEqual({
      title: 'IN',
      headers: ['日付', '売上'],
      rows: [['1/1', 100]],
      slides: [{ title: 'A', body: 'B' }],
      count: 3,
      flag: true,
      nothing: null,
    });
  });

  it('LLM が JSON 文字列で出した配列引数を実体に戻す（Ajv の type: array を通す）', () => {
    const out = renderArgTemplate(
      { headers: '["日付","売上"]', rows: '[["1/1",100]]', text: '{{prev}}' },
      { input: 'IN', prev: '売上まとめ' },
    );
    expect(out.headers).toEqual(['日付', '売上']);
    expect(out.rows).toEqual([['1/1', 100]]);
    expect(out.text).toBe('売上まとめ');
  });

  it('置換が起きた値は JSON 復元しない（本文がオブジェクトに化けるのを防ぐ）', () => {
    // {{prev}} には前ステップの出力 JSON（例 {"url":"..."}）が入る。ここで復元してしまうと
    // Slack 本文やメール本文が文字列でなくなり、Ajv の type: string で必ず落ちる。
    const out = renderArgTemplate(
      { text: '{{prev}}', rows: '{{input}}' },
      { input: '[["a",1]]', prev: '{"url":"https://doc"}' },
    );
    expect(out.text).toBe('{"url":"https://doc"}');
    expect(out.rows).toBe('[["a",1]]');
  });

  it('リテラルの中に {{input}} を差し込む形なら実体に戻す', () => {
    const out = renderArgTemplate({ rows: '[["{{input}}",1]]' }, { input: '1/1', prev: '' });
    expect(out.rows).toEqual([['1/1', 1]]);
  });
});

describe('looksLikeJsonTemplate', () => {
  it('プレースホルダを除いた素の文字列で判定する（{{prev}} は本文であって JSON ではない）', () => {
    expect(looksLikeJsonTemplate('{{prev}}')).toBe(false);
    expect(looksLikeJsonTemplate('前: {{ prev }}')).toBe(false);
    expect(looksLikeJsonTemplate('こんにちは')).toBe(false);
    expect(looksLikeJsonTemplate('["a","b"]')).toBe(true);
    expect(looksLikeJsonTemplate('[["{{input}}",1]]')).toBe(true);
    expect(looksLikeJsonTemplate('{"a":1}')).toBe(true);
  });
});

describe('coerceJsonLike', () => {
  it('[ / { 始まりの JSON 文字列だけ実体に戻す', () => {
    expect(coerceJsonLike('["a","b"]')).toEqual(['a', 'b']);
    expect(coerceJsonLike('  {"a":1}  ')).toEqual({ a: 1 });
  });
  it('JSON でない文字列はそのまま（本文を壊さない）', () => {
    expect(coerceJsonLike('こんにちは')).toBe('こんにちは');
    expect(coerceJsonLike('{{foo}}')).toBe('{{foo}}');
    expect(coerceJsonLike('{未完了')).toBe('{未完了');
    // [ / { で始まらない JSON リテラルは数値化しない（"123" が 123 になると型が変わる）
    expect(coerceJsonLike('123')).toBe('123');
    expect(coerceJsonLike('true')).toBe('true');
  });
  it('string 以外はそのまま返す', () => {
    const arr = ['a'];
    expect(coerceJsonLike(arr)).toBe(arr);
    expect(coerceJsonLike(5)).toBe(5);
    expect(coerceJsonLike(null)).toBeNull();
    expect(coerceJsonLike(undefined)).toBeUndefined();
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
      // approve 側が条件付き更新で claim 済み（PENDING_APPROVAL → RUNNING）の状態
      status: 'RUNNING',
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
      status: 'RUNNING',
      executionResult: null,
      approvalData: null,
    });
    prismaMock.agent.findUnique.mockResolvedValue(null);

    await resumeAgentTask('t1');

    expect(lastUpdateData().status).toBe('FAILED');
  });

  it('却下済み・完了済みの Task は再開しない（外部送信を蒸し返さない）', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      id: 't1',
      orgId: 'org-1',
      agentId: 'A1',
      status: 'REJECTED',
      executionResult: null,
      approvalData: null,
    });

    await resumeAgentTask('t1');

    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(prismaMock.task.update).not.toHaveBeenCalled();
  });

  it('承認内容を復元できないときは RUNNING のまま放置せず FAILED にする', async () => {
    prismaMock.task.findUnique.mockResolvedValue({
      id: 't1',
      orgId: 'org-1',
      agentId: 'A1',
      status: 'RUNNING',
      executionResult: null,
      approvalData: null,
    });
    prismaMock.agent.findUnique.mockResolvedValue({
      id: 'A1',
      instructions: AGENT.instructions,
      department: AGENT.department,
      createdBy: AGENT.createdBy,
      steps: AGENT.steps,
    });

    await resumeAgentTask('t1');

    expect(resolveMock).not.toHaveBeenCalled();
    expect(lastUpdateData().status).toBe('FAILED');
  });
});

describe('recoverStaleRunningTasks', () => {
  it('古い RUNNING の agent タスクだけを FAILED にして件数を返す', async () => {
    prismaMock.task.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    prismaMock.task.updateMany.mockResolvedValue({ count: 1 });

    const n = await recoverStaleRunningTasks(30 * 60_000);

    expect(n).toBe(2);
    const where = prismaMock.task.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('RUNNING');
    expect(where.taskType).toBe('agent');
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    // 条件付き更新で claim している（他インスタンスと二重回収しない）
    expect(prismaMock.task.updateMany).toHaveBeenCalledTimes(2);
    const claim = prismaMock.task.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: 't1', status: 'RUNNING' });
    expect(claim.data.status).toBe('FAILED');
    expect(String(claim.data.lastError)).toBe(STALE_RUNNING_MESSAGE);
    // TaskLog も残す
    expect(prismaMock.taskLog.create).toHaveBeenCalledTimes(2);
  });

  it('他インスタンスに先を越された分（count 0）は数えない', async () => {
    prismaMock.task.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    prismaMock.task.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    expect(await recoverStaleRunningTasks()).toBe(1);
    expect(prismaMock.taskLog.create).toHaveBeenCalledTimes(1);
  });

  it('対象なしなら 0 を返し、更新もしない', async () => {
    prismaMock.task.findMany.mockResolvedValue([]);
    expect(await recoverStaleRunningTasks()).toBe(0);
    expect(prismaMock.task.updateMany).not.toHaveBeenCalled();
  });
});
