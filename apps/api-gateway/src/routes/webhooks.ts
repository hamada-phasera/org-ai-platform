import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { dispatchQueuedTask } from '../services/task-executor';
import { finalizeGenerationOutput, type GenerationTaskType } from '../services/generation-dispatch';
import { prepDueSnsPosts } from '../services/sns-publish-prep';
import { runKpiAlertCheck } from '../services/kpi-alerts';

const WEBHOOK_AUTH_TOKEN = process.env.N8N_WEBHOOK_AUTH_TOKEN ?? 'org-ai-n8n-secret-token';

const GENERATION_TASK_TYPES: ReadonlySet<string> = new Set(['proposal', 'sns'] satisfies GenerationTaskType[]);

const taskCompleteSchema = z.object({
  taskId: z.string(),
  status: z.enum(['DONE', 'FAILED']),
  output: z.string().optional(),
  error: z.string().optional(),
  workflowId: z.string().optional(),
});

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // n8n からのタスク完了コールバック
  app.post('/n8n/task-complete', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }

    const result = taskCompleteSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    }

    const { taskId, status, output, error, workflowId } = result.data;

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'タスクが見つかりません' } });
    }

    // 生成系 Task（提案書/SNS下書き・D1）は raw LLM 出力を taskType 別に整形する。
    // sns は PENDING_APPROVAL に遷移（承認ゲートへ。DONE にしない = 投稿されない）。
    if (status === 'DONE' && task.taskType && GENERATION_TASK_TYPES.has(task.taskType)) {
      if (workflowId) {
        await prisma.task.update({ where: { id: taskId }, data: { n8nWorkflowId: workflowId } });
      }
      await finalizeGenerationOutput(taskId, task.taskType as GenerationTaskType, output ?? '');
      const finalized = await prisma.task.findUnique({ where: { id: taskId } });
      return reply.send({ success: true, data: finalized });
    }

    const updated = await prisma.task.update({
      where: { id: taskId },
      data: {
        status,
        output: output ?? null,
        lastError: error ?? null,
        n8nWorkflowId: workflowId ?? null,
        executedAt: new Date(),
      },
    });

    // 完了ログ追加
    await prisma.taskLog.create({
      data: {
        taskId,
        message: status === 'DONE'
          ? `n8n ワークフロー完了: タスクが正常に実行されました`
          : `n8n ワークフロー失敗: ${error ?? '不明なエラー'}`,
        level: status === 'DONE' ? 'INFO' : 'ERROR',
      },
    });

    return reply.send({ success: true, data: updated });
  });

  // n8n からの進捗ログ追加
  app.post('/n8n/task-log', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }

    const schema = z.object({
      taskId: z.string(),
      message: z.string(),
      level: z.enum(['INFO', 'WARN', 'ERROR']).default('INFO'),
    });

    const result = schema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ success: false, error: { code: 'VALIDATION_ERROR', message: result.error.message } });
    }

    const log = await prisma.taskLog.create({
      data: {
        taskId: result.data.taskId,
        message: result.data.message,
        level: result.data.level,
      },
    });

    return reply.code(201).send({ success: true, data: log });
  });

  // QUEUEDタスク一覧（n8n ポーリング用）
  app.get('/n8n/queued-tasks', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }

    const tasks = await prisma.task.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    return reply.send({ success: true, data: tasks });
  });

  // 定期実行ジョブ一覧（n8n schedule-dispatcher 用）
  // 現在の UTC 時刻 (hour 単位) と一致する有効なジョブを返す
  app.get('/n8n/scheduled-jobs', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }

    const now = new Date();
    const currentHourUtc = now.getUTCHours();
    const currentDayOfWeek = now.getUTCDay();
    const currentDayOfMonth = now.getUTCDate();

    const candidates = await prisma.scheduledTask.findMany({
      where: { enabled: true, hourUtc: currentHourUtc },
      include: { org: { select: { plan: true, billingEmail: true } } },
    });

    const jobs = candidates.filter((s) => {
      if (s.frequency === 'daily') return true;
      if (s.frequency === 'weekly') return s.dayOfWeek === currentDayOfWeek;
      if (s.frequency === 'monthly') return s.dayOfMonth === currentDayOfMonth;
      return false;
    });

    return reply.send({
      success: true,
      data: jobs.map((s) => ({
        id: s.id,
        orgId: s.orgId,
        title: s.title,
        department: s.department,
        taskType: s.taskType,
        input: s.input,
        recipientEmail: s.recipientEmail ?? s.org.billingEmail ?? null,
        plan: s.org.plan,
        callbackUrl: `${process.env.API_GATEWAY_URL ?? 'http://localhost:4000'}/api/webhooks/n8n/scheduled-job-complete`,
        aiEngineUrl: process.env.AI_ENGINE_URL ?? 'http://localhost:8000',
      })),
    });
  });

  // 定期ジョブを Task として enqueue（n8n schedule-dispatcher が呼ぶ）
  app.post('/n8n/enqueue-scheduled-task', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }
    const schema = z.object({ scheduledTaskId: z.string() });
    const result = schema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: result.error.message },
      });
    }
    const st = await prisma.scheduledTask.findUnique({ where: { id: result.data.scheduledTaskId } });
    if (!st || !st.enabled) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: '有効な定期タスクが見つかりません' },
      });
    }
    // Task 作成（QUEUED で作成 → n8n が自動発火）
    const task = await prisma.task.create({
      data: {
        orgId: st.orgId,
        title: `[定期] ${st.title}`,
        department: st.department,
        input: st.input,
        status: 'QUEUED',
        taskType: st.taskType,
      },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: `定期実行から起動 (scheduledTaskId=${st.id})`, level: 'INFO' },
    });
    await prisma.scheduledTask.update({
      where: { id: st.id },
      data: { lastRunAt: new Date() },
    });
    // n8n もしくは AI Engine で実行
    void dispatchQueuedTask(task);
    return reply.send({ success: true, data: { taskId: task.id, scheduledTaskId: st.id } });
  });

  // SNS 投稿準備 cron（D2 段階1）。APPROVED + scheduledAt 到来の下書きに
  // プレビュー生成・キュー投入マークを付ける。**実投稿は一切しない**。
  app.post('/n8n/sns-publish-prep', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }
    const result = await prepDueSnsPosts();
    return reply.send({ success: true, data: result });
  });

  // 分析 KPI アラート cron（A-6 / 監視系）。閾値超過を RiskEvent として記録する。
  app.post('/n8n/kpi-alert-check', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }
    const result = await runKpiAlertCheck();
    return reply.send({ success: true, data: result });
  });

  // 定期ジョブ実行完了の callback（lastRunAt を更新）
  app.post('/n8n/scheduled-job-complete', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: '認証トークンが無効です' } });
    }
    const schema = z.object({
      scheduledTaskId: z.string(),
      status: z.enum(['DONE', 'FAILED']),
      error: z.string().optional(),
    });
    const result = schema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: result.error.message },
      });
    }
    const updated = await prisma.scheduledTask.update({
      where: { id: result.data.scheduledTaskId },
      data: { lastRunAt: new Date() },
    });
    return reply.send({ success: true, data: updated });
  });
}
