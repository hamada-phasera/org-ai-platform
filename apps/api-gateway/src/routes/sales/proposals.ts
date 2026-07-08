import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../utils/prisma';
import { requireAuth } from '../../middleware/auth';
import {
  PROPOSAL_TEMPLATES,
  getTemplate,
  buildProposalMessages,
  type ProposalInputs,
} from './proposal-templates';

/**
 * 提案書ドラフト生成（S-3・主機能）。
 *
 * LLM 呼び出しは CLAUDE.md の規約に従い AI Engine の `/llm/chat` 経由で行う（直接呼び出し禁止）。
 * `/llm/chat` は PII スクリーニング(llm_router.chat)を通すが AILog を書かないため、
 * 「すべての AI 入出力を AILog に記録する」ルールを満たすよう本ルートで prisma.aILog.create する
 * （/llm/chat 側での集中ロギング化は integration-requests #5 に起票）。
 *
 * 生成結果は完了 Task(taskType='proposal') として保存し、既存の deliverables 表示に載せる
 * （この製品では「成果物」= status='DONE' の Task。Deliverable モデルは存在しない）。
 * ルート登録(index.ts)は統合フェーズ(B)。prefix 例: `/api/sales/proposals`。
 */

interface LLMChatResponse {
  content: string;
  model: string;
  tokens_used: number;
  latency_ms: number;
  pii_detected: boolean;
}

const generateSchema = z.object({
  templateId: z.string().optional(),
  customerName: z.string().min(1).max(200),
  background: z.string().max(4000).optional(),
  requirements: z.string().max(4000).optional(),
  budget: z.string().max(200).optional(),
  dealId: z.string().optional(),
  /** 生成結果を完了 Task として保存するか（既定: true）。 */
  persist: z.boolean().optional(),
});

type AuthPayload = { orgId: string; sub?: string };

export async function salesProposalsRoutes(app: FastifyInstance): Promise<void> {
  // 組み込みテンプレート一覧
  app.get('/templates', { preHandler: requireAuth }, async (_request, reply) => {
    return reply.send({ success: true, data: PROPOSAL_TEMPLATES });
  });

  // 提案書ドラフト生成
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

    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';
    const messages = buildProposalMessages(template, inputs);

    // ── LLM 呼び出し（AI Engine 経由・規約準拠） ──────────────
    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
    let res: Response;
    try {
      res = await fetch(`${aiEngineUrl}/llm/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          department: 'SALES',
          org_id: payload.orgId,
          plan,
          json_mode: false,
          user_email: (request.user as { email?: string }).email ?? null, // 松竹梅ルーティング
        }),
      });
    } catch (e) {
      request.log.error({ err: e }, '[sales/proposals] ai-engine unreachable');
      return reply.code(502).send({
        success: false,
        error: { code: 'AI_ENGINE_UNAVAILABLE', message: 'AI エンジンに接続できません。' },
      });
    }

    const text = await res.text();
    if (!res.ok) {
      return reply.code(res.status >= 500 ? 502 : res.status).send({
        success: false,
        error: { code: 'LLM_UPSTREAM_ERROR', message: text.slice(0, 800) },
      });
    }

    let llm: LLMChatResponse;
    try {
      llm = JSON.parse(text) as LLMChatResponse;
    } catch {
      return reply.code(502).send({
        success: false,
        error: { code: 'LLM_BAD_RESPONSE', message: 'AI エンジンの応答を解釈できませんでした。' },
      });
    }

    const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';

    // ── AILog 記録（必須。best-effort: 失敗しても生成結果は返す） ──
    try {
      await prisma.aILog.create({
        data: {
          orgId: payload.orgId,
          department: 'SALES',
          provider: 'anthropic',
          model: llm.model,
          inputText: userPrompt.slice(0, 4000),
          outputText: (llm.content ?? '').slice(0, 4000),
          tokens: llm.tokens_used ?? null,
          latencyMs: llm.latency_ms ?? null,
          riskScore: null,
        },
      });
    } catch (e) {
      request.log.error({ err: e }, '[sales/proposals] AILog 記録に失敗');
    }

    // ── 成果物として Task 保存（既定 true。deliverables 表示に載る） ──
    let taskId: string | null = null;
    if (parsed.data.persist !== false) {
      try {
        const task = await prisma.task.create({
          data: {
            orgId: payload.orgId,
            title: `提案書ドラフト: ${inputs.customerName}`,
            status: 'DONE',
            department: 'SALES',
            taskType: 'proposal',
            input: JSON.stringify({ templateId: template.id, ...inputs }),
            output: JSON.stringify({ proposal: llm.content, templateId: template.id, model: llm.model }),
          },
        });
        taskId = task.id;
      } catch (e) {
        request.log.error({ err: e }, '[sales/proposals] Task 保存に失敗');
      }
    }

    return reply.send({
      success: true,
      data: {
        proposal: llm.content,
        templateId: template.id,
        model: llm.model,
        piiDetected: llm.pii_detected ?? false,
        taskId,
      },
    });
  });
}
