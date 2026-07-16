import { prisma } from '../utils/prisma';
import { isWebhookAvailableByName, triggerN8nWorkflowByPath } from './task-executor';
import {
  PLATFORM_CONSTRAINTS,
  isSnsPlatform,
  normalizeHashtags,
  parseDraftBody,
  validatePost,
  type SnsDraft,
  type SnsPlatform,
} from '../routes/sns/format';

/**
 * 生成系 dept 操作（提案書 / SNS 下書き）の Task/dispatch 実装 — n8n 統合設計 D1。
 *
 * 原則は既存 dispatch モデルと同じ:
 *   DB(Task)=真実の源 / n8n=best-effort 加速 / AI Engine(/llm/chat)=必ず完了するフォールバック。
 * LLM 呼び出しはどちらの経路でも AI Engine `/llm/chat` を通るため、AILog は
 * ai-engine 側の集中ロギング（コンプラ#5 対応済み）で自動記録される。
 * ルート側での直 `/llm/chat` 呼び出し・重複 aILog.create はこのモジュールへの移行で廃止。
 */

export type GenerationTaskType = 'proposal' | 'sns';

/** 生成系操作 → n8n 連携情報。WF はテンプレ (apps/n8n-workflows/gen-*.json) を手動取込。 */
export const GENERATION_WORKFLOWS: Record<GenerationTaskType, { webhookPath: string; workflowName: string }> = {
  proposal: { webhookPath: 'sales-proposal', workflowName: 'org-ai Sales Proposal' },
  sns: { webhookPath: 'sns-draft', workflowName: 'org-ai SNS Draft' },
};

export interface GenerationSpec {
  taskType: GenerationTaskType;
  systemPrompt: string;
  userPrompt: string;
  /** /llm/chat の json_mode（SNS 下書きは true）。 */
  jsonMode: boolean;
  /** 松竹梅ルーティング用（JWT の email クレーム）。 */
  userEmail?: string | null;
}

interface GenerationTask {
  id: string;
  orgId: string;
  title: string;
  input: string;
  department: string;
}

function safeParseJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 生成完了時の taskType 別後処理。n8n コールバック / AI Engine フォールバックの両経路から呼ぶ。
 * - proposal: output を { proposal, templateId, model } の JSON に整形し DONE。
 * - sns: 本文をドラフト JSON に整形・検証し **PENDING_APPROVAL**（承認ゲートへ。投稿はしない）。
 */
export async function finalizeGenerationOutput(
  taskId: string,
  taskType: GenerationTaskType,
  rawContent: string,
  meta?: { model?: string },
): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return;

  if (!rawContent.trim()) {
    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'FAILED', lastError: '生成結果が空でした' },
    });
    await prisma.taskLog.create({
      data: { taskId, message: '生成結果が空のため失敗として記録', level: 'ERROR' },
    });
    return;
  }

  const input = safeParseJson(task.input);

  if (taskType === 'proposal') {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'DONE',
        output: JSON.stringify({
          proposal: rawContent,
          templateId: typeof input.templateId === 'string' ? input.templateId : null,
          ...(meta?.model ? { model: meta.model } : {}),
        }),
        executedAt: new Date(),
      },
    });
    await prisma.taskLog.create({
      data: { taskId, message: '提案書ドラフト生成が完了しました', level: 'INFO' },
    });
    return;
  }

  // sns: ドラフト整形 → 承認待ちキューへ（実投稿はしない）
  const platform: SnsPlatform = isSnsPlatform(input.platform) ? input.platform : 'twitter';
  const body = parseDraftBody(rawContent);
  const hashtags = normalizeHashtags(body.hashtags).slice(
    0,
    PLATFORM_CONSTRAINTS[platform].maxHashtags ?? undefined,
  );
  const draft: SnsDraft = { platform, content: body.content, hashtags };
  const validation = validatePost(platform, draft.content, draft.hashtags);
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'PENDING_APPROVAL',
      output: JSON.stringify({ ...draft, validation }),
      executedAt: new Date(),
    },
  });
  await prisma.taskLog.create({
    data: { taskId, message: 'SNS下書きを生成し承認待ちに追加しました（投稿はされません）', level: 'INFO' },
  });
}

/** AI Engine `/llm/chat` で直接生成するフォールバック経路。 */
export async function executeGenerationViaAiEngine(task: GenerationTask, spec: GenerationSpec): Promise<void> {
  const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
  const org = await prisma.organization.findUnique({
    where: { id: task.orgId },
    select: { plan: true },
  });
  try {
    await prisma.taskLog.create({
      data: { taskId: task.id, message: 'AI Engine で生成を開始', level: 'INFO' },
    });
    const res = await fetch(`${aiEngineUrl}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: spec.systemPrompt },
          { role: 'user', content: spec.userPrompt },
        ],
        department: task.department,
        org_id: task.orgId,
        plan: org?.plan ?? 'STARTER',
        json_mode: spec.jsonMode,
        user_email: spec.userEmail ?? null,
      }),
    });
    if (!res.ok) throw new Error(`AI Engine returned ${res.status}`);
    const result = (await res.json()) as { content: string; model?: string };
    await finalizeGenerationOutput(task.id, spec.taskType, result.content ?? '', { model: result.model });
  } catch (e) {
    console.error('[generation-fallback] failed:', e);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'FAILED', lastError: String(e) },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: `生成失敗: ${String(e)}`, level: 'ERROR' },
    });
  }
}

/**
 * 生成系 Task を発火する共通エントリ（QUEUED で作成された Task を渡す）。
 * 専用 n8n WF がアクティブなら webhook（受理後の完了は n8n コールバック →
 * webhooks.ts が finalizeGenerationOutput を呼ぶ）、不達なら AI Engine で必ず完了させる。
 */
export async function dispatchGenerationTask(task: GenerationTask, spec: GenerationSpec): Promise<void> {
  const wf = GENERATION_WORKFLOWS[spec.taskType];
  const available = await isWebhookAvailableByName(wf.workflowName);
  if (available) {
    const ok = await triggerN8nWorkflowByPath(
      wf.webhookPath,
      { ...task, taskType: spec.taskType },
      spec.systemPrompt,
      undefined,
      { userPrompt: spec.userPrompt, jsonMode: spec.jsonMode, userEmail: spec.userEmail },
    );
    if (ok) {
      await prisma.taskLog.create({
        data: { taskId: task.id, message: `n8n ワークフロー(${wf.webhookPath})に生成を投入`, level: 'INFO' },
      });
      return; // 完了は n8n コールバック経由
    }
    console.warn(`[generation] n8n webhook ${wf.webhookPath} 不達 → AI Engine にフォールバック (task=${task.id})`);
  }
  await executeGenerationViaAiEngine(task, spec);
}
