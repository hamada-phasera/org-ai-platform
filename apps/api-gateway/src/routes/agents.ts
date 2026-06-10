import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth, requireOwner } from '../middleware/auth';
import { dispatchAgentTask } from '../services/task-executor';
import {
  createAgentWorkflow,
  syncAgentWorkflow,
  deleteAgentWorkflow,
} from '../services/n8n-workflow-builder';

const DEPARTMENTS = ['SALES', 'MARKETING', 'ACCOUNTING', 'ANALYTICS', 'GENERAL', 'ASSISTANT'];

const stepSchema = z.object({
  capabilityName: z.string().min(1),
  argTemplate: z.record(z.string()).optional(),
});

const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  department: z.string().default('GENERAL'),
  instructions: z.string().min(1).optional(),
  steps: z.array(stepSchema).optional(),
  trigger: z.enum(['MANUAL', 'SCHEDULED']).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  inferFromDescription: z.boolean().optional(),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).nullable().optional(),
  department: z.string().optional(),
  instructions: z.string().min(1).optional(),
  steps: z.array(stepSchema).nullable().optional(),
  trigger: z.enum(['MANUAL', 'SCHEDULED']).optional(),
  enabled: z.boolean().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});

const runAgentSchema = z.object({ input: z.string().optional() });

/** AI Engine /plan/agent でチャット説明文からエージェント定義を推論する（best-effort）。 */
async function inferAgentDefinition(
  description: string,
  orgId: string,
  plan: string,
): Promise<{
  name?: string;
  department?: string;
  instructions?: string;
  steps?: { capabilityName: string; argTemplate?: Record<string, string> }[];
  trigger?: 'MANUAL' | 'SCHEDULED';
} | null> {
  const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
  const capabilities = await prisma.capability.findMany({
    where: { orgId },
    select: { name: true, displayName: true, description: true, department: true, inputSchema: true },
  });
  try {
    const res = await fetch(`${aiEngineUrl}/plan/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, org_id: orgId, plan, available_capabilities: capabilities }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    return {
      name: typeof j.name === 'string' ? j.name : undefined,
      department: typeof j.department === 'string' ? j.department : undefined,
      instructions: typeof j.instructions === 'string' ? j.instructions : undefined,
      steps: Array.isArray(j.steps)
        ? (j.steps as { capabilityName: string; argTemplate?: Record<string, string> }[])
        : undefined,
      trigger: j.trigger === 'SCHEDULED' ? 'SCHEDULED' : j.trigger === 'MANUAL' ? 'MANUAL' : undefined,
    };
  } catch {
    return null;
  }
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // 部署別エージェント統計
  app.get('/stats', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const orgId = payload.orgId;

    // 部署別タスク数を一括取得
    const [totalCounts, runningCounts, queuedCounts, doneCounts] = await Promise.all([
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId },
      }),
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId, status: 'RUNNING' },
      }),
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId, status: 'QUEUED' },
      }),
      prisma.task.groupBy({
        by: ['department'],
        _count: true,
        where: { orgId, status: 'DONE' },
      }),
    ]);

    // マップに変換
    const totalMap = new Map(totalCounts.map((r) => [r.department, r._count]));
    const runningMap = new Map(runningCounts.map((r) => [r.department, r._count]));
    const queuedMap = new Map(queuedCounts.map((r) => [r.department, r._count]));
    const doneMap = new Map(doneCounts.map((r) => [r.department, r._count]));

    // 各部署の最新完了タスクを取得
    const latestTasks = await Promise.all(
      DEPARTMENTS.map(async (dept) => {
        const task = await prisma.task.findFirst({
          where: { orgId, department: dept, status: 'DONE' },
          orderBy: { updatedAt: 'desc' },
          select: { output: true, title: true },
        });
        return { dept, task };
      }),
    );

    // 完了タスクがない部署はAILogから最新を取得
    const latestReports = new Map<string, string | null>();
    for (const { dept, task } of latestTasks) {
      if (task?.output) {
        // outputが長い場合は先頭100文字に切り詰め
        latestReports.set(dept, task.output.slice(0, 100));
      } else {
        const log = await prisma.aILog.findFirst({
          where: { orgId, department: dept },
          orderBy: { createdAt: 'desc' },
          select: { outputText: true },
        });
        latestReports.set(dept, log?.outputText?.slice(0, 100) ?? null);
      }
    }

    // レスポンス構築
    const data: Record<string, {
      taskCount: number;
      status: 'active' | 'processing' | 'idle';
      latestReport: string | null;
      completedCount: number;
      runningCount: number;
    }> = {};

    for (const dept of DEPARTMENTS) {
      const running = runningMap.get(dept) ?? 0;
      const queued = queuedMap.get(dept) ?? 0;
      let status: 'active' | 'processing' | 'idle' = 'idle';
      if (running > 0) status = 'active';
      else if (queued > 0) status = 'processing';

      data[dept] = {
        taskCount: totalMap.get(dept) ?? 0,
        status,
        latestReport: latestReports.get(dept) ?? null,
        completedCount: doneMap.get(dept) ?? 0,
        runningCount: running,
      };
    }

    return reply.send({ success: true, data });
  });

  // ───────────── 保存エージェント (作成 / 一覧 / 実行) ─────────────

  // 保存エージェント一覧（再選択用）
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const agents = await prisma.agent.findMany({
      where: { orgId: payload.orgId },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: agents });
  });

  // 保存エージェント単体
  app.get('/:agentId', { preHandler: requireAuth }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const payload = request.user as { orgId: string };
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.orgId !== payload.orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'エージェントが見つかりません' } });
    }
    return reply.send({ success: true, data: agent });
  });

  // 保存エージェント作成（任意で n8n 専用ワークフローを best-effort 生成）
  app.post('/', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as { sub: string; orgId: string };
    const parsed = createAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const body = parsed.data;

    // 説明文からの推論（opt-in）。未指定フィールドのみ埋める。
    let { name, department, instructions, steps, trigger } = body;
    if (body.inferFromDescription && body.description) {
      const org = await prisma.organization.findUnique({
        where: { id: payload.orgId },
        select: { plan: true },
      });
      const inferred = await inferAgentDefinition(
        body.description,
        payload.orgId,
        org?.plan ?? 'STARTER',
      );
      if (inferred) {
        name = name || inferred.name || name;
        department = department || inferred.department || department;
        instructions = instructions || inferred.instructions;
        steps = steps || inferred.steps;
        trigger = trigger || inferred.trigger;
      }
    }

    if (!instructions) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'instructions が必要です（または inferFromDescription を有効に）' },
      });
    }

    let agent;
    try {
      agent = await prisma.agent.create({
        data: {
          orgId: payload.orgId,
          name,
          description: body.description ?? null,
          department: department ?? 'GENERAL',
          instructions,
          steps: steps ?? undefined,
          trigger: trigger ?? 'MANUAL',
          icon: body.icon ?? null,
          color: body.color ?? null,
          createdBy: payload.sub,
          n8nStatus: 'PENDING',
        },
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes('Unique constraint')) {
        return reply
          .code(409)
          .send({ success: false, error: { code: 'CONFLICT', message: '同名のエージェントが既に存在します' } });
      }
      throw e;
    }

    // n8n 専用ワークフロー生成（失敗しても PENDING で続行）
    try {
      const result = await createAgentWorkflow({
        id: agent.id,
        name: agent.name,
        department: agent.department,
        instructions: agent.instructions,
      });
      agent = await prisma.agent.update({
        where: { id: agent.id },
        data: {
          n8nWorkflowId: result.workflowId,
          webhookPath: result.webhookPath,
          n8nStatus: result.active ? 'ACTIVE' : 'CREATED',
        },
      });
    } catch (e) {
      app.log.warn(`[agent] n8n workflow 生成失敗 (id=${agent.id}): ${String(e)} — PENDING で続行`);
    }

    return reply.code(201).send({ success: true, data: agent });
  });

  // 保存エージェント実行（再呼び出し）
  app.post('/:agentId/run', { preHandler: requireAuth }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const payload = request.user as { orgId: string };
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.orgId !== payload.orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'エージェントが見つかりません' } });
    }
    if (!agent.enabled) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'AGENT_DISABLED', message: 'このエージェントは無効です' } });
    }

    const parsed = runAgentSchema.safeParse(request.body ?? {});
    const input = parsed.success && parsed.data.input ? parsed.data.input : agent.instructions;

    const task = await prisma.task.create({
      data: {
        orgId: payload.orgId,
        agentId: agent.id,
        title: `[エージェント] ${agent.name}`,
        department: agent.department,
        input,
        status: 'QUEUED',
        taskType: 'agent',
      },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: `エージェント実行を開始: ${agent.name}`, level: 'INFO' },
    });

    void dispatchAgentTask(
      { id: task.id, orgId: task.orgId, title: task.title, input: task.input, taskType: 'agent' },
      {
        id: agent.id,
        instructions: agent.instructions,
        department: agent.department,
        webhookPath: agent.webhookPath,
        n8nStatus: agent.n8nStatus,
      },
    );

    return reply.code(201).send({ success: true, data: { taskId: task.id, agentId: agent.id } });
  });

  // 保存エージェント更新
  app.patch('/:agentId', { preHandler: requireOwner }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const payload = request.user as { orgId: string };
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.orgId !== payload.orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'エージェントが見つかりません' } });
    }
    const parsed = updateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const d = parsed.data;
    const updated = await prisma.agent.update({
      where: { id: agentId },
      data: {
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.description !== undefined ? { description: d.description } : {}),
        ...(d.department !== undefined ? { department: d.department } : {}),
        ...(d.instructions !== undefined ? { instructions: d.instructions } : {}),
        ...(d.steps !== undefined ? { steps: d.steps ?? undefined } : {}),
        ...(d.trigger !== undefined ? { trigger: d.trigger } : {}),
        ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
        ...(d.icon !== undefined ? { icon: d.icon } : {}),
        ...(d.color !== undefined ? { color: d.color } : {}),
      },
    });

    // 定義が変わったら n8n ワークフローを同期（best-effort）
    const defChanged =
      d.name !== undefined || d.department !== undefined || d.instructions !== undefined;
    if (defChanged && updated.n8nWorkflowId) {
      const ok = await syncAgentWorkflow(updated.n8nWorkflowId, {
        id: updated.id,
        name: updated.name,
        department: updated.department,
        instructions: updated.instructions,
      });
      if (!ok) {
        await prisma.agent.update({ where: { id: agentId }, data: { n8nStatus: 'PENDING' } });
      }
    }

    return reply.send({ success: true, data: updated });
  });

  // 保存エージェント削除（実行履歴は Task.agentId が SET NULL で保持される）
  app.delete('/:agentId', { preHandler: requireOwner }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const payload = request.user as { orgId: string };
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.orgId !== payload.orgId) {
      return reply
        .code(404)
        .send({ success: false, error: { code: 'NOT_FOUND', message: 'エージェントが見つかりません' } });
    }
    if (agent.n8nWorkflowId) await deleteAgentWorkflow(agent.n8nWorkflowId);
    await prisma.agent.delete({ where: { id: agentId } });
    return reply.send({ success: true, data: { deleted: true } });
  });
}
