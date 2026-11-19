import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantDb } from '../tenancy/tenant-db';
import { getMembership } from '../tenancy/membership-cache';
import { authOf } from '../tenancy';
import { requireAuth } from '../middleware/auth';
import { dispatchQueuedTask } from '../services/task-executor';
import { resumeAgentTask, parseRunState } from '../services/step-runner';
import { tracked } from '../services/lifecycle-core';
import { approveFlowStep, parseFlowApproval, rejectFlowStep } from '../services/flows/queue';
import { sendError } from '../utils/http-error';

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  department: z.string(),
  input: z.string(),
  status: z.string().default('PENDING'),
  taskType: z.string().optional(),
});

const approveTaskSchema = z.object({
  action: z.string().optional(),
  modifications: z.record(z.unknown()).optional(),
  /** エージェントのステップ承認: 承認画面で編集した引数（本文など）。 */
  editedArgs: z.record(z.unknown()).optional(),
});

const rejectTaskSchema = z.object({
  reason: z.string().max(500).optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.string().optional(),
  output: z.string().optional(),
});

const addLogSchema = z.object({
  message: z.string().min(1),
  level: z.enum(['INFO', 'WARN', 'ERROR']).default('INFO'),
});

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  // タスク一覧取得
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const query = request.query as { department?: string; status?: string; taskType?: string };
    const where: { orgId: string; department?: string; status?: string; taskType?: string } = {
      orgId: payload.orgId,
    };
    if (query.department) where.department = query.department;
    if (query.status) where.status = query.status;
    if (query.taskType) where.taskType = query.taskType;
    const tasks = await db.task.findMany({
      where,
      include: { logs: { orderBy: { createdAt: 'asc' }, take: 20 } },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: tasks });
  });

  // タスク単体取得
  app.get('/:taskId', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const payload = authOf(request);
    const { db } = payload;
    const task = await db.task.findUnique({
      where: { id: taskId },
      include: { logs: { orderBy: { createdAt: 'asc' }, take: 50 } },
    });
    if (!task || task.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
    }
    return reply.send({ success: true, data: task });
  });

  // タスク作成
  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = authOf(request);
    const { db } = payload;
    const result = createTaskSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }
    const task = await db.task.create({
      data: {
        orgId: payload.orgId,
        title: result.data.title,
        department: result.data.department,
        input: result.data.input,
        status: result.data.status,
        taskType: result.data.taskType ?? null,
      },
    });
    // 作成ログ
    await db.taskLog.create({
      data: { taskId: task.id, message: `タスクを作成しました: ${task.title}`, level: 'INFO' },
    });

    // QUEUED状態で作成された場合、n8n or AI Engineで実行
    if (task.status === 'QUEUED') {
      void dispatchQueuedTask(task);
    }

    return reply.code(201).send({ success: true, data: task });
  });

  // タスク更新
  app.patch('/:taskId', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const payload = authOf(request);
    const { db } = payload;

    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task || task.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
    }

    const result = updateTaskSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }

    const updated = await db.task.update({
      where: { id: taskId },
      data: result.data,
    });

    if (result.data.status && result.data.status !== task.status) {
      await db.taskLog.create({
        data: { taskId, message: `ステータス変更: ${task.status} → ${result.data.status}`, level: 'INFO' },
      });
      // QUEUED になったら n8n or AI Engine で実行
      if (result.data.status === 'QUEUED') {
        void dispatchQueuedTask(updated);
      }
    }

    return reply.send({ success: true, data: updated });
  });

  // タスク承認（PENDING_APPROVAL → QUEUED で実行フェーズをトリガー）
  app.post('/:taskId/approve', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const payload = authOf(request);
    const { db } = payload;

    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task || task.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
    }

    const body = approveTaskSchema.safeParse(request.body);

    // 業務フローの確認（approvalData.kind === 'flow_step'）は FlowRun を条件付きで取り直して続きを 1 回だけ走らせる
    // （docs/design/canvas-home.md §7.4）。承認画面での編集は受けない（人が見た中身をそのまま通す）
    const flowApproval = parseFlowApproval(task.approvalData);
    if (flowApproval) {
      const res = await approveFlowStep(db, task, flowApproval, { userId: payload.sub, role: payload.role });
      if (!res.ok) return sendError(reply, res.status, res.code, res.message);
      const current = await db.task.findUnique({ where: { id: taskId } });
      return reply.send({ success: true, data: current });
    }

    // エージェントのステップ承認（approvalData.kind === 'agent_step'）は step-runner を再開する。
    // 従来の承認（SNS 下書き等）は QUEUED に戻して dispatchQueuedTask。
    let isAgentStep = false;
    if (task.approvalData) {
      try {
        isAgentStep = (JSON.parse(task.approvalData) as { kind?: string }).kind === 'agent_step';
      } catch {
        isAgentStep = false;
      }
    }
    if (isAgentStep) {
      // 二重承認（ボタン連打・再送）で Slack 投稿やメール送信が 2 回走らないよう、
      // status を読んでから実行する read-then-act をやめ、条件付き更新で atomic に claim する。
      // PENDING_APPROVAL を掴めた 1 リクエストだけが resumeAgentTask を呼べる。
      const claimed = await db.task.updateMany({
        where: { id: taskId, orgId: payload.orgId, status: 'PENDING_APPROVAL' },
        data: { status: 'RUNNING' },
      });
      if (claimed.count === 0) {
        return sendError(reply, 409, 'INVALID_STATE', 'このタスクは承認待ちではありません');
      }
      await db.taskLog.create({
        data: { taskId, message: 'ステップを承認しました。実行を再開します', level: 'INFO' },
      });
      // claim 済み（既に RUNNING）でも resumeAgentTask は続行する
      tracked('agent-resume', taskId, () =>
        resumeAgentTask(taskId, {
          orgId: payload.orgId,
          editedArgs: body.success ? body.data.editedArgs : undefined,
        }),
      );
      const current = await db.task.findUnique({ where: { id: taskId } });
      return reply.send({ success: true, data: current });
    }

    const approvalData = body.success ? JSON.stringify(body.data) : null;

    const updated = await db.task.update({
      where: { id: taskId },
      data: {
        status: 'QUEUED',
        approvalData,
      },
    });

    await db.taskLog.create({
      data: { taskId, message: `タスクを承認しました（${body.data?.action ?? '実行'}）`, level: 'INFO' },
    });

    // n8n or AI Engine で実行
    void dispatchQueuedTask(updated);

    return reply.send({ success: true, data: updated });
  });

  // タスク却下（エージェントのステップ承認待ちを止める。残りステップは実行しない）
  app.post('/:taskId/reject', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const payload = authOf(request);
    const { db } = payload;

    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task || task.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
    }
    const body = rejectTaskSchema.safeParse(request.body ?? {});
    const reason = body.success ? body.data.reason : undefined;

    const flowApproval = parseFlowApproval(task.approvalData);
    if (flowApproval) {
      const res = await rejectFlowStep(db, task, flowApproval, reason);
      if (!res.ok) return sendError(reply, res.status, res.code, res.message);
      const updated = await db.task.findUnique({ where: { id: taskId } });
      return reply.send({ success: true, data: updated });
    }

    // 承認待ちだったステップを REJECTED として executionResult に反映（履歴が読めるように）
    const state = parseRunState(task.executionResult);
    if (state) {
      const step = state.steps[state.currentIndex];
      if (step && step.status === 'AWAITING_APPROVAL') step.status = 'REJECTED';
    }

    // approve と同じく条件付き更新で claim。承認と却下が同時に来ても片方だけが通る。
    const claimed = await db.task.updateMany({
      where: { id: taskId, orgId: payload.orgId, status: 'PENDING_APPROVAL' },
      data: {
        status: 'REJECTED',
        lastError: reason ?? null,
        ...(state ? { executionResult: JSON.stringify(state) } : {}),
      },
    });
    if (claimed.count === 0) {
      return sendError(reply, 409, 'INVALID_STATE', 'このタスクは承認待ちではありません');
    }
    await db.taskLog.create({
      data: { taskId, message: `承認を却下しました${reason ? `: ${reason}` : ''}`, level: 'INFO' },
    });
    const updated = await db.task.findUnique({ where: { id: taskId } });
    return reply.send({ success: true, data: updated });
  });

  // タスク削除
  app.delete('/:taskId', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const payload = authOf(request);
    const { db } = payload;

    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task || task.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
    }

    await db.taskLog.deleteMany({ where: { taskId } });
    await db.task.delete({ where: { id: taskId } });
    return reply.send({ success: true, data: { deleted: true } });
  });

  // タスクログ追加
  app.post('/:taskId/logs', { preHandler: requireAuth }, async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const payload = authOf(request);
    const { db } = payload;

    const task = await db.task.findUnique({ where: { id: taskId } });
    if (!task || task.orgId !== payload.orgId) {
      return sendError(reply, 404, 'NOT_FOUND', 'タスクが見つかりません');
    }

    const result = addLogSchema.safeParse(request.body);
    if (!result.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', result.error.message);
    }

    const log = await db.taskLog.create({
      data: { taskId, message: result.data.message, level: result.data.level },
    });
    return reply.code(201).send({ success: true, data: log });
  });

  // WebSocket: タスクログのリアルタイム配信
  // WebSocketはブラウザAPIでヘッダーを送れないため、query paramでtoken認証する
  app.get('/:taskId/stream', { websocket: true }, async (socket, request) => {
    const { taskId } = request.params as { taskId: string };
    const { token } = request.query as { token?: string };

    // query param のトークンを検証
    let payload: { orgId?: string | null; sub?: string };
    try {
      if (token) {
        payload = app.jwt.verify<{ orgId: string; sub: string }>(token);
      } else {
        // Authorization ヘッダーにフォールバック
        await request.jwtVerify();
        payload = request.user as { orgId: string; sub: string };
      }
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: '認証エラー' }));
      socket.close();
      return;
    }
    /* requireAuth と同じく、トークンの組織に今も所属しているかを確かめる（外された人に流し続けない）。
       ポーリングのたびにも確かめる（30 秒キャッシュなので負荷は増えない）。 */
    const stillMember = async (): Promise<boolean> => {
      if (!payload.orgId || !payload.sub) return false;
      const snap = await getMembership(payload.sub, payload.orgId);
      return snap.userStatus === 'ACTIVE' && snap.membership?.status === 'ACTIVE';
    };
    if (!(await stillMember())) {
      socket.send(JSON.stringify({ type: 'error', message: '認証エラー' }));
      socket.close();
      return;
    }
    const db = tenantDb(payload.orgId as string);

    // 接続確認メッセージ
    socket.send(JSON.stringify({ type: 'connected', taskId }));

    // ポーリングで新着ログを送信（5秒ごと）
    let lastLogId: string | null = null;
    const interval = setInterval(async () => {
      try {
        const task = await db.task.findUnique({ where: { id: taskId } });
        if (!task || !(await stillMember())) {
          clearInterval(interval);
          socket.close();
          return;
        }

        const where = lastLogId
          ? { taskId, id: { gt: lastLogId } }
          : { taskId };

        const logs = await db.taskLog.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          take: 50,
        });

        if (logs.length > 0) {
          lastLogId = logs[logs.length - 1].id;
          socket.send(JSON.stringify({ type: 'logs', data: logs }));
        }

        // タスク完了時は接続を閉じる
        if (task.status === 'DONE' || task.status === 'FAILED') {
          socket.send(JSON.stringify({ type: 'done', status: task.status }));
          clearInterval(interval);
          socket.close();
        }
      } catch {
        clearInterval(interval);
      }
    }, 2000);

    socket.on('close', () => clearInterval(interval));
  });
}
