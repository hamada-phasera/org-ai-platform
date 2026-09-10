// 汎用ステップ実行器。Agent.steps（[{capabilityName, argTemplate}]）を順に実行する。
// 手動 run / 定期実行 / 承認後の再開のすべてがここを通る。
//
// 設計の要点:
// - run の状態は Task.executionResult に AgentRunState の JSON 文字列で毎ステップ保存
//   （新テーブルは作らない。クラッシュしても進捗が追える）。
// - 外部送信 capability（APPROVAL_REQUIRED_CAPS）は実行「前」に必ず停止し、
//   Task.status='PENDING_APPROVAL' + approvalData に内容を積む。承認 UI（受信ページ）が
//   RunPreviewRow で表示し、POST /api/tasks/:id/approve → resumeAgentTask で再開する。
// - ステップの n8n グラフ展開はしない（Render WAF 制約 + ハードコード地獄の回避）。
//   capability 実行は resolveAndExecute（name 指定 = confidence ゲート素通り）に集約。

import type { AgentRunState, AgentStepApprovalData, AgentStepDef, StepState } from '@org-ai/shared-types';
import { APPROVAL_REQUIRED_CAPS, LLM_TRANSFORM_STEP } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { resolveAndExecute } from './capability-resolver';

const AI_ENGINE_URL = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';

// ── pure（vitest 対象） ────────────────────────────────────────────

/**
 * 値が JSON らしき文字列（先頭が [ か {）なら実体に戻す。
 *
 * capability の inputSchema には配列引数がある（create_google_sheet の headers / rows、
 * create_google_slides の slides）。LLM はそれを `"[\"a\",\"b\"]"` のような JSON 文字列で
 * 出すことがあり、そのまま渡すと Ajv の type: array に必ず落ちて VALIDATION_ERROR になる。
 * パースできない文字列は元のまま返す（本文がたまたま「{」で始まるだけのケースを壊さない）。
 */
export function coerceJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/**
 * argTemplate の {{input}} / {{prev}} を置換する。それ以外のプレースホルダは増やさない。
 *
 * 値は string とは限らない。AI 推論で作られた steps は zod を通らずに保存される
 * （routes/agents.ts の inferAgentDefinition は型アサートのみ）ため、配列・オブジェクト・数値が
 * そのまま入ってくる。以前は無条件に value.replace を呼んでいて TypeError で run 全体が落ちていた。
 * - string のときだけ置換し、JSON 文字列なら実体に戻す
 * - string 以外はそのまま通す（配列・オブジェクト・数値を壊さない）
 */
export function renderArgTemplate(
  template: Record<string, unknown>,
  ctx: { input: string; prev: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    const hasPlaceholder = /\{\{\s*(input|prev)\s*\}\}/.test(value);
    const rendered = value.replace(/\{\{\s*(input|prev)\s*\}\}/g, (_, name: string) =>
      name === 'input' ? ctx.input : ctx.prev,
    );
    // JSON 復元はテンプレートに直接書かれたリテラルにだけ適用する。
    // 置換後の値まで対象にすると、{{prev}} に前ステップの出力 JSON（例 {"url":"..."}）が
    // 入ったときに本文がオブジェクトへ化けてしまう。Slack 本文やメール本文が
    // 文字列でなくなると Ajv の type: string で必ず落ちるので、ここは分けること。
    out[key] = hasPlaceholder ? rendered : coerceJsonLike(rendered);
  }
  return out;
}

export function requiresApproval(capabilityName: string): boolean {
  return (APPROVAL_REQUIRED_CAPS as readonly string[]).includes(capabilityName);
}

export function initRunState(input: string, steps: AgentStepDef[]): AgentRunState {
  return {
    version: 1,
    input,
    currentIndex: 0,
    steps: steps.map((s, index) => ({
      index,
      capabilityName: s.capabilityName,
      status: 'PENDING' as const,
    })),
  };
}

export function parseRunState(executionResult: string | null): AgentRunState | null {
  if (!executionResult) return null;
  try {
    const parsed = JSON.parse(executionResult) as AgentRunState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.steps)) return parsed;
    return null;
  } catch {
    return null;
  }
}

// ── 実行本体 ──────────────────────────────────────────────────────

export interface StepAgentContext {
  id: string;
  instructions: string;
  department: string;
  createdBy: string;
  steps: AgentStepDef[];
}

async function persistState(taskId: string, state: AgentRunState): Promise<void> {
  await prisma.task.update({
    where: { id: taskId },
    data: { executionResult: JSON.stringify(state) },
  });
}

async function log(taskId: string, message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): Promise<void> {
  await prisma.taskLog.create({ data: { taskId, message, level } });
}

/** Task を FAILED にして理由をログにも残す。RUNNING で claim 済みの Task を放置しないための出口。 */
async function failTask(taskId: string, message: string): Promise<void> {
  await prisma.task
    .update({ where: { id: taskId }, data: { status: 'FAILED', lastError: message } })
    .catch(() => {});
  await log(taskId, message, 'ERROR').catch(() => {});
}

/** 再起動で取り残された RUNNING Task に入れる理由（UI にそのまま出る）。 */
export const STALE_RUNNING_MESSAGE = 'gateway の再起動により中断されました。もう一度実行してください';

/** AI Engine /llm/chat を直接呼ぶ予約ステップ（capability レジストリ・承認は通らない）。 */
async function runLlmTransform(
  orgId: string,
  agent: StepAgentContext,
  prompt: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  try {
    const res = await fetch(`${AI_ENGINE_URL}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: agent.instructions },
          { role: 'user', content: prompt },
        ],
        department: agent.department,
        org_id: orgId,
        plan: org?.plan ?? 'STARTER',
        json_mode: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { ok: false, error: `AI Engine returned ${res.status}` };
    const json = (await res.json()) as { content?: unknown };
    return { ok: true, content: typeof json.content === 'string' ? json.content : '' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function stringifyOutput(data: unknown, message: string): string {
  if (typeof data === 'string') return data;
  if (data != null) {
    try {
      return JSON.stringify(data);
    } catch {
      /* fallthrough */
    }
  }
  return message;
}

async function capabilityLabel(orgId: string, name: string): Promise<string> {
  const cap = await prisma.capability.findUnique({
    where: { orgId_name: { orgId, name } },
    select: { displayName: true },
  });
  return cap?.displayName ?? name;
}

/** 1 ステップを実際に実行する（承認判定は呼び出し側で済んでいる前提）。 */
async function executeStep(
  orgId: string,
  agent: StepAgentContext,
  capabilityName: string,
  args: Record<string, unknown>,
  fallbackPrompt: string,
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (capabilityName === LLM_TRANSFORM_STEP) {
    // prompt が配列等で来ても落とさない（文字列でなければ fallback）
    const prompt = typeof args.prompt === 'string' && args.prompt ? args.prompt : fallbackPrompt;
    const result = await runLlmTransform(orgId, agent, prompt);
    if (result.ok) return { ok: true, output: result.content };
    return { ok: false, output: '', error: result.error };
  }

  const outcome = await resolveAndExecute({
    name: capabilityName,
    args,
    // 定期実行にはリクエストユーザーがいないため、エージェント作成者として実行する（決め）
    userId: agent.createdBy,
    orgId,
  });
  switch (outcome.outcome) {
    case 'EXECUTED':
      if (outcome.envelope.status === 'success') {
        return { ok: true, output: stringifyOutput(outcome.envelope.data, outcome.envelope.message) };
      }
      return { ok: false, output: '', error: outcome.envelope.message || outcome.envelope.error_type || '実行失敗' };
    case 'NEEDS_AUTH':
      return { ok: false, output: '', error: `接続が必要です (${outcome.missing.join(', ')})。設定 > 連携 から接続してください` };
    case 'VALIDATION_ERROR':
      return { ok: false, output: '', error: `引数が不正です: ${outcome.errors.join(' / ')}` };
    case 'UNSUPPORTED':
      return { ok: false, output: '', error: `capability が見つかりません: ${capabilityName}` };
    case 'NEEDS_CONFIRMATION':
      // name 指定なので通常到達しない（防御）
      return { ok: false, output: '', error: '内部エラー: 確認ゲートに到達しました' };
  }
}

/**
 * currentIndex から残りステップを進める。承認が必要なステップの手前で
 * PENDING_APPROVAL にして返る。全部終われば Task を DONE にする。
 */
async function advance(taskId: string, orgId: string, agent: StepAgentContext, state: AgentRunState): Promise<void> {
  const total = state.steps.length;
  for (let i = state.currentIndex; i < total; i++) {
    const def = agent.steps[i];
    const step: StepState = state.steps[i];
    const prev = i > 0 ? (state.steps[i - 1].output ?? '') : '';
    const args: Record<string, unknown> = def.argTemplate
      ? renderArgTemplate(def.argTemplate, { input: state.input, prev })
      : {};

    // 外部送信は実行前に必ず止める（編集・承認は受信ページで）
    if (requiresApproval(def.capabilityName) && step.status !== 'RUNNING') {
      step.status = 'AWAITING_APPROVAL';
      step.args = args;
      state.currentIndex = i;
      const approval: AgentStepApprovalData = {
        kind: 'agent_step',
        stepIndex: i,
        capabilityName: def.capabilityName,
        capabilityLabel: await capabilityLabel(orgId, def.capabilityName),
        args,
      };
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'PENDING_APPROVAL',
          approvalData: JSON.stringify(approval),
          executionResult: JSON.stringify(state),
        },
      });
      await log(taskId, `承認待ち: ${approval.capabilityLabel}（ステップ ${i + 1}/${total}）。受信ページから承認すると送信されます`);
      return;
    }

    step.status = 'RUNNING';
    step.args = args;
    step.startedAt = new Date().toISOString();
    state.currentIndex = i;
    await persistState(taskId, state);

    const fallbackPrompt = prev || state.input;
    const result = await executeStep(orgId, agent, def.capabilityName, args, fallbackPrompt);
    step.finishedAt = new Date().toISOString();

    if (!result.ok) {
      step.status = 'FAILED';
      step.error = result.error;
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'FAILED',
          lastError: `step ${i + 1} (${def.capabilityName}): ${result.error ?? '失敗'}`,
          executionResult: JSON.stringify(state),
        },
      });
      await log(taskId, `ステップ ${i + 1}/${total} 失敗 (${def.capabilityName}): ${result.error ?? ''}`, 'ERROR');
      return;
    }

    step.status = 'DONE';
    step.output = result.output;
    state.currentIndex = i + 1;
    await persistState(taskId, state);
    await log(taskId, `ステップ ${i + 1}/${total} 完了: ${def.capabilityName}`);
  }

  const lastOutput = state.steps[total - 1]?.output ?? '';
  await prisma.task.update({
    where: { id: taskId },
    data: { status: 'DONE', output: lastOutput, executedAt: new Date() },
  });
  await log(taskId, 'すべてのステップが完了しました');
}

/** steps を持つエージェントの Task 実行エントリ（手動 run / 定期どちらもここ）。 */
export async function runAgentTask(
  task: { id: string; orgId: string; input: string },
  agent: StepAgentContext,
): Promise<void> {
  try {
    const state = initRunState(task.input, agent.steps);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'RUNNING', executionResult: JSON.stringify(state) },
    });
    await log(task.id, `ステップ実行を開始（全 ${agent.steps.length} ステップ）`);
    await advance(task.id, task.orgId, agent, state);
  } catch (e) {
    console.error('[step-runner] runAgentTask failed:', e);
    await prisma.task
      .update({ where: { id: task.id }, data: { status: 'FAILED', lastError: String(e) } })
      .catch(() => {});
    await log(task.id, `実行失敗: ${String(e)}`, 'ERROR').catch(() => {});
  }
}

/**
 * 承認された Task を再開する。editedArgs があれば承認画面での編集を反映。
 * 承認済みステップを実行し、成功したら残りのステップを続行する。
 *
 * 呼び出し元（POST /api/tasks/:id/approve）は updateMany の条件付き更新で
 * PENDING_APPROVAL → RUNNING を atomic に claim してからここを呼ぶ（二重承認で外部送信が
 * 2 回走らないため）。したがって「既に RUNNING」は正常系で、ここでは止めない。
 * 再開に必要な情報は Task.approvalData（どのステップを承認したか）と
 * Task.executionResult（それまでの run 状態）から復元する＝DB が真実の源。
 */
export async function resumeAgentTask(
  taskId: string,
  opts?: { editedArgs?: Record<string, unknown> },
): Promise<void> {
  try {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return;
    // RUNNING = approve が claim 済み / PENDING_APPROVAL = claim を経ない旧経路。それ以外は再開しない
    // （却下済み・完了済みを蒸し返さない）。
    if (task.status && task.status !== 'RUNNING' && task.status !== 'PENDING_APPROVAL') {
      console.warn(`[step-runner] resumeAgentTask: 再開できない状態のため中断 (${task.status})`);
      return;
    }
    if (!task.agentId) {
      await failTask(taskId, 'エージェントが紐づいていないため再開できません');
      return;
    }
    const agentRow = await prisma.agent.findUnique({ where: { id: task.agentId } });
    if (!agentRow) {
      await failTask(taskId, 'エージェントが削除されています');
      return;
    }
    const state = parseRunState(task.executionResult);
    const approval = task.approvalData
      ? (JSON.parse(task.approvalData) as AgentStepApprovalData)
      : null;
    if (!state || !approval || approval.kind !== 'agent_step') {
      // claim 済みだと RUNNING のまま固まるので必ず出口を作る
      await failTask(taskId, '承認内容を復元できませんでした（実行状態が壊れています）');
      return;
    }

    const agent: StepAgentContext = {
      id: agentRow.id,
      instructions: agentRow.instructions,
      department: agentRow.department,
      createdBy: agentRow.createdBy,
      steps: (agentRow.steps as unknown as AgentStepDef[] | null) ?? [],
    };

    const i = approval.stepIndex;
    const step = state.steps[i];
    const def = agent.steps[i];
    if (!step || !def) {
      await failTask(taskId, `承認されたステップ (${i + 1}) がエージェント定義に見つかりません`);
      return;
    }

    // 編集を反映。以前は文字列以外を JSON.stringify していたが、それだと配列引数が
    // 文字列のまま capability に渡って VALIDATION_ERROR になる。実体のまま通し、
    // 承認 UI が文字列で返してきた JSON だけ coerceJsonLike で戻す。
    const args: Record<string, unknown> = {};
    const source = opts?.editedArgs && Object.keys(opts.editedArgs).length > 0 ? opts.editedArgs : (step.args ?? {});
    for (const [k, v] of Object.entries(source)) args[k] = coerceJsonLike(v);

    step.status = 'RUNNING';
    step.args = args;
    step.startedAt = new Date().toISOString();
    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'RUNNING', executionResult: JSON.stringify(state) },
    });
    await log(taskId, `承認されました: ${approval.capabilityLabel} を実行します`);

    const prev = i > 0 ? (state.steps[i - 1].output ?? '') : '';
    const result = await executeStep(task.orgId, agent, def.capabilityName, args, prev || state.input);
    step.finishedAt = new Date().toISOString();

    if (!result.ok) {
      step.status = 'FAILED';
      step.error = result.error;
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'FAILED',
          lastError: `step ${i + 1} (${def.capabilityName}): ${result.error ?? '失敗'}`,
          executionResult: JSON.stringify(state),
        },
      });
      await log(taskId, `ステップ ${i + 1} 失敗 (${def.capabilityName}): ${result.error ?? ''}`, 'ERROR');
      return;
    }

    step.status = 'DONE';
    step.output = result.output;
    state.currentIndex = i + 1;
    await persistState(taskId, state);
    await log(taskId, `ステップ ${i + 1}/${state.steps.length} 完了: ${def.capabilityName}`);

    await advance(taskId, task.orgId, agent, state);
  } catch (e) {
    console.error('[step-runner] resumeAgentTask failed:', e);
    await prisma.task
      .update({ where: { id: taskId }, data: { status: 'FAILED', lastError: String(e) } })
      .catch(() => {});
  }
}

/**
 * gateway 再起動（デプロイ）で RUNNING のまま取り残された agent Task を回収する。
 *
 * run はプロセス内のループなので、途中で落ちると Task が RUNNING のまま永久に残り、
 * UI 上「実行中」で固まる。起動時にこれを呼んで、閾値より古い RUNNING を FAILED に落とす。
 * 実行中の run は毎ステップ executionResult を書く＝updatedAt が動くので巻き込まれない。
 *
 * 呼び出し（index.ts への配線）は別途行う。ここは export のみ。
 * @returns 回収した件数
 */
export async function recoverStaleRunningTasks(olderThanMs = 30 * 60_000): Promise<number> {
  const threshold = new Date(Date.now() - olderThanMs);
  const stale = await prisma.task.findMany({
    where: { status: 'RUNNING', taskType: 'agent', updatedAt: { lt: threshold } },
    select: { id: true },
  });
  if (stale.length === 0) return 0;

  let recovered = 0;
  for (const { id } of stale) {
    // 条件付き更新で claim（複数インスタンスが同時に起動しても二重回収しない）
    const claimed = await prisma.task.updateMany({
      where: { id, status: 'RUNNING' },
      data: { status: 'FAILED', lastError: STALE_RUNNING_MESSAGE },
    });
    if (claimed.count === 0) continue;
    recovered += 1;
    await log(id, STALE_RUNNING_MESSAGE, 'ERROR').catch(() => {});
  }
  if (recovered > 0) {
    console.warn(`[step-runner] 中断されていた RUNNING タスクを ${recovered} 件回収しました`);
  }
  return recovered;
}
