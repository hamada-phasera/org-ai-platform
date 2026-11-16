import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { claimAndEnqueueScheduledTask, startOfCurrentHourUtc } from '../services/schedule-dispatcher';
import { config } from '../config/env';
import { sendError } from '../utils/http-error';
import { createLogger } from '../utils/logger';

const WEBHOOK_AUTH_TOKEN = config.n8nWebhookAuthToken;
const webhookLog = createLogger('webhooks/n8n');

/* ⚠️ トークンの既定値はコードとドキュメントに書いてある＝公開されている。
   本番でこのまま動かすと、誰でも全テナントの Task を書き換えられる（E1）。
   起動は止めない（今のワークフローを壊さないため）が、必ず目に付くように出す。 */
if (config.isProduction && config.n8nWebhookAuthTokenIsDefault) {
  webhookLog.error(
    'N8N_WEBHOOK_AUTH_TOKEN が既定値のままです。本番では必ず推測できない値に変えてください（n8n 側の Header Auth も同じ値に）',
  );
}

/**
 * コールバックが名乗る orgId と、対象の行の orgId を照合する（E1）。
 *
 *   * orgId が付いていて食い違う → false（呼び出し側は 404。存在を漏らさない）
 *   * orgId が無い → N8N_CALLBACK_ORG_REQUIRED=true なら false、既定（移行期間）は警告して true
 *
 * 共有トークン1本で全テナントの行を触れる経路なので、トークンが漏れても
 * 「行の id と org の両方を知っていないと触れない」ようにする。
 */
function callbackOrgMatches(claimedOrgId: string | undefined, rowOrgId: string, what: string): boolean {
  if (claimedOrgId) return claimedOrgId === rowOrgId;
  if (config.n8nCallbackOrgRequired) return false;
  webhookLog.warn(`${what}: コールバックに orgId がありません（古いワークフロー）。ワークフローを再生成してください`);
  return true;
}

const taskCompleteSchema = z.object({
  taskId: z.string(),
  orgId: z.string().min(1).optional(),
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
      return sendError(reply, 401, 'UNAUTHORIZED', '認証トークンが無効です');
    }

    const result = taskCompleteSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }

    const { taskId, orgId, status, output, error, workflowId } = result.data;
    if (!orgId && config.n8nCallbackOrgRequired) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'orgId は必須です');
    }

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || !callbackOrgMatches(orgId, task.orgId, `task-complete(task=${taskId})`)) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
    }

    const updated = await prisma.task.update({
      // 照合済みの org を書き込みの条件にも入れる（照合と書き込みの間で行が入れ替わることはないが、念のため）
      where: { id: taskId, orgId: task.orgId },
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
      return sendError(reply, 401, 'UNAUTHORIZED', '認証トークンが無効です');
    }

    const schema = z.object({
      taskId: z.string(),
      orgId: z.string().min(1).optional(),
      message: z.string(),
      level: z.enum(['INFO', 'WARN', 'ERROR']).default('INFO'),
    });

    const result = schema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    if (!result.data.orgId && config.n8nCallbackOrgRequired) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'orgId は必須です');
    }
    const task = await prisma.task.findUnique({
      where: { id: result.data.taskId },
      select: { id: true, orgId: true },
    });
    if (!task || !callbackOrgMatches(result.data.orgId, task.orgId, `task-log(task=${result.data.taskId})`)) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
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

  // QUEUEDタスク一覧（n8n ポーリング用）。
  // ⚠️ 全テナントを横断する経路なので、中身（input など）は返さない（E2）。
  //    リポジトリ内のワークフローはこのポーリングを使っていない。使っていないと確認できたら廃止する。
  app.get('/n8n/queued-tasks', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return sendError(reply, 401, 'UNAUTHORIZED', '認証トークンが無効です');
    }

    const tasks = await prisma.task.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: { id: true, orgId: true, status: true, createdAt: true },
    });

    return reply.send({ success: true, data: tasks });
  });

  // 定期実行ジョブ一覧（n8n schedule-dispatcher 用）
  // 現在の UTC 時刻 (hour 単位) と一致する有効なジョブを返す
  app.get('/n8n/scheduled-jobs', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return sendError(reply, 401, 'UNAUTHORIZED', '認証トークンが無効です');
    }

    const now = new Date();
    const currentHourUtc = now.getUTCHours();
    const currentDayOfWeek = now.getUTCDay();
    const currentDayOfMonth = now.getUTCDate();

    const candidates = await prisma.scheduledTask.findMany({
      where: {
        enabled: true,
        hourUtc: currentHourUtc,
        // 当該時間帯に実行済みのものは返さない（dispatcher が 1 時間に 2 回走っても二重 enqueue しない。
        // 最終防衛線は enqueue 側の atomic claim）
        OR: [{ lastRunAt: null }, { lastRunAt: { lt: startOfCurrentHourUtc(now) } }],
      },
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
        callbackUrl: `${config.apiGatewayUrl}/api/webhooks/n8n/scheduled-job-complete`,
        aiEngineUrl: config.aiEngineUrl,
      })),
    });
  });

  // 定期ジョブを Task として enqueue（n8n schedule-dispatcher が呼ぶ）
  app.post('/n8n/enqueue-scheduled-task', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return sendError(reply, 401, 'UNAUTHORIZED', '認証トークンが無効です');
    }
    const schema = z.object({ scheduledTaskId: z.string() });
    const result = schema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    // atomic claim（lastRunAt の条件付き更新）+ エージェント分岐は schedule-dispatcher に集約。
    // 既に当該時間帯に走っていれば冪等 skip（success で返し、n8n 側の再送を止める）。
    const outcome = await claimAndEnqueueScheduledTask(result.data.scheduledTaskId);
    if (!outcome.enqueued) {
      if (outcome.reason === 'not_found') {
        return sendError(reply, 404, 'NOT_FOUND', '有効な定期タスクが見つかりません');
      }
      return reply.send({
        success: true,
        data: { skipped: true, reason: outcome.reason, scheduledTaskId: result.data.scheduledTaskId },
      });
    }
    return reply.send({
      success: true,
      data: { taskId: outcome.taskId, scheduledTaskId: result.data.scheduledTaskId },
    });
  });

  // 定期ジョブ実行完了の callback（lastRunAt を更新）
  app.post('/n8n/scheduled-job-complete', async (request, reply) => {
    const authToken = request.headers['x-webhook-token'];
    if (authToken !== WEBHOOK_AUTH_TOKEN) {
      return sendError(reply, 401, 'UNAUTHORIZED', '認証トークンが無効です');
    }
    const schema = z.object({
      scheduledTaskId: z.string(),
      orgId: z.string().min(1).optional(),
      status: z.enum(['DONE', 'FAILED']),
      error: z.string().optional(),
    });
    const result = schema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    if (!result.data.orgId && config.n8nCallbackOrgRequired) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'orgId は必須です');
    }
    const st = await prisma.scheduledTask.findUnique({
      where: { id: result.data.scheduledTaskId },
      select: { id: true, orgId: true },
    });
    if (!st || !callbackOrgMatches(result.data.orgId, st.orgId, `scheduled-job-complete(st=${st?.id})`)) {
      return sendError(reply, 404, 'NOT_FOUND', '定期タスクが見つかりません');
    }
    const updated = await prisma.scheduledTask.update({
      where: { id: st.id, orgId: st.orgId },
      data: { lastRunAt: new Date() },
    });
    return reply.send({ success: true, data: updated });
  });
}
