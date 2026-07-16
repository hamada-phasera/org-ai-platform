import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import { dispatchGenerationTask } from '../../services/generation-dispatch';
import {
  PROPOSAL_TEMPLATES,
  getTemplate,
  buildProposalMessages,
  type ProposalInputs,
} from './proposal-templates';

/**
 * 提案書ドラフト生成（S-3）— n8n 統合設計 D1 準拠の Task/dispatch モデル。
 *
 * POST は Task(taskType='proposal', status='QUEUED') を作成して 202 を返し、
 * 実行は dispatchGenerationTask（n8n 加速 + AI Engine フォールバック）が行う。
 * 完了すると Task が DONE になり output に { proposal, templateId, model } が入る
 * （進捗は GET /api/tasks/:id か WS /api/tasks/:id/stream で追える）。
 *
 * LLM はどちらの経路でも AI Engine `/llm/chat` を通り、AILog は ai-engine の
 * 集中ロギングで記録される（本ルートでの直呼び出し・重複 aILog.create は廃止）。
 */

const generateSchema = z.object({
  templateId: z.string().optional(),
  customerName: z.string().min(1).max(200),
  background: z.string().max(4000).optional(),
  requirements: z.string().max(4000).optional(),
  budget: z.string().max(200).optional(),
  dealId: z.string().optional(),
});

type AuthPayload = { orgId: string; sub?: string; email?: string };

export async function salesProposalsRoutes(app: FastifyInstance): Promise<void> {
  // 組み込みテンプレート一覧
  app.get('/templates', { preHandler: requireAuth }, async (_request, reply) => {
    return reply.send({ success: true, data: PROPOSAL_TEMPLATES });
  });

  // 提案書ドラフト生成（非同期 Task 化）
  app.post('/', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const template = getTemplate(parsed.data.templateId);
    if (!template) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `不明なテンプレート: ${parsed.data.templateId}` },
      });
    }

    const inputs: ProposalInputs = {
      customerName: parsed.data.customerName,
      background: parsed.data.background,
      requirements: parsed.data.requirements,
      budget: parsed.data.budget,
    };
    const messages = buildProposalMessages(template, inputs);
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';

    const task = await prisma.task.create({
      data: {
        orgId: payload.orgId,
        title: `提案書ドラフト: ${inputs.customerName}`,
        status: 'QUEUED',
        department: 'SALES',
        taskType: 'proposal',
        input: JSON.stringify({
          templateId: template.id,
          ...inputs,
          ...(parsed.data.dealId ? { dealId: parsed.data.dealId } : {}),
        }),
      },
    });
    await prisma.taskLog.create({
      data: { taskId: task.id, message: '提案書生成をキューに投入しました', level: 'INFO' },
    });

    // n8n 加速 + AI Engine フォールバックで必ず完了する（fire-and-forget）
    dispatchGenerationTask(task, {
      taskType: 'proposal',
      systemPrompt,
      userPrompt,
      jsonMode: false,
      userEmail: payload.email ?? null,
    }).catch((e) => request.log.error({ err: e }, '[sales/proposals] dispatch failed'));

    return reply.code(202).send({
      success: true,
      data: { taskId: task.id, status: 'QUEUED', templateId: template.id },
    });
  });
}
