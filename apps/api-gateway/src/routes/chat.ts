import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireAuth } from '../middleware/auth';

const N8N_CLOUD_URL = process.env.N8N_CLOUD_URL ?? 'https://hamahiro.app.n8n.cloud';
const N8N_API_KEY = process.env.N8N_API_KEY ?? '';
const N8N_CHAT_WORKFLOW_NAME = 'org-ai Chat Response';

let cachedChatWorkflowId: string | null = null;

/** n8n cloud API でチャット用ワークフローIDを解決 */
async function resolveChatWorkflowId(): Promise<string | null> {
  if (cachedChatWorkflowId) return cachedChatWorkflowId;
  if (!N8N_API_KEY) return null;
  try {
    const res = await fetch(`${N8N_CLOUD_URL}/api/v1/workflows`, {
      headers: { 'X-N8N-API-KEY': N8N_API_KEY },
    });
    if (!res.ok) return null;
    const json = await res.json() as { data: { id: string; name: string }[] };
    const wf = json.data.find((w) => w.name === N8N_CHAT_WORKFLOW_NAME);
    if (wf) cachedChatWorkflowId = wf.id;
    return cachedChatWorkflowId;
  } catch {
    return null;
  }
}

/** n8n cloud でチャット回答を生成（失敗時はai-engineにフォールバック） */
async function generateViaN8n(payload: {
  message: string;
  department: string | null;
  orgId: string;
  sessionId: string;
  history: { role: string; content: string }[];
  plan: string;
  aiEngineUrl: string;
}): Promise<{ content: string; department: string } | null> {
  const workflowId = await resolveChatWorkflowId();
  if (!workflowId) return null;
  try {
    const res = await fetch(`${N8N_CLOUD_URL}/api/v1/workflows/${workflowId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': N8N_API_KEY },
      body: JSON.stringify({ runData: payload }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { resultData?: { runData?: Record<string, { data?: [{ json?: { content?: string; department?: string } }] }[]> } } };
    const runData = json.data?.resultData?.runData;
    if (runData) {
      const lastNode = Object.values(runData).at(-1);
      const result = lastNode?.[0]?.data?.[0]?.json;
      if (result?.content) {
        return { content: result.content, department: result.department ?? 'GENERAL' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

const sendMessageSchema = z.object({
  content: z.string().min(1),
  department: z.string().optional(),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/sessions', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { sub: string; orgId: string };
    const session = await prisma.chatSession.create({
      data: { orgId: payload.orgId },
    });
    return reply.code(201).send({ success: true, data: session });
  });

  app.get('/sessions', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const sessions = await prisma.chatSession.findMany({
      where: { orgId: payload.orgId },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ success: true, data: sessions });
  });

  /** 組織内の全セッションタイトル・メッセージ本文を横断検索（秘書AI検索用） */
  app.get('/search', { preHandler: requireAuth }, async (request, reply) => {
    const payload = request.user as { orgId: string };
    const q = typeof request.query === 'object' && request.query && 'q' in request.query
      ? String((request.query as { q?: string }).q ?? '').trim()
      : '';
    if (q.length < 1) {
      return reply.send({
        success: true,
        data: { sessions: [] as unknown[], messages: [] as unknown[] },
      });
    }

    const [sessionHits, messageHits] = await Promise.all([
      prisma.chatSession.findMany({
        where: {
          orgId: payload.orgId,
          title: { contains: q, mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
        take: 15,
      }),
      prisma.message.findMany({
        where: {
          content: { contains: q, mode: 'insensitive' },
          session: { orgId: payload.orgId },
        },
        include: {
          session: { select: { id: true, title: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ]);

    return reply.send({
      success: true,
      data: {
        sessions: sessionHits.map((s) => ({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt.toISOString(),
        })),
        messages: messageHits.map((m) => ({
          id: m.id,
          sessionId: m.sessionId,
          sessionTitle: m.session.title,
          role: m.role,
          snippet: m.content.length > 200 ? `${m.content.slice(0, 200)}…` : m.content,
          createdAt: m.createdAt.toISOString(),
        })),
      },
    });
  });

  // 従来の非ストリーミングエンドポイント（互換性維持）
  app.post('/sessions/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const payload = request.user as { sub: string; orgId: string };

    const result = sendMessageSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: result.error.message },
      });
    }

    const session = await prisma.chatSession.findUnique({ where: { id } });
    if (!session || session.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'セッションが見つかりません' } });
    }

    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';

    const userMessage = await prisma.message.create({
      data: { sessionId: id, role: 'user', content: result.data.content },
    });

    const recentMessages = await prisma.message.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const history = recentMessages.reverse().map((m) => ({ role: m.role, content: m.content }));

    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://ai-engine:8000';
    let aiResponse: { content: string; department: string };
    const n8nResult = await generateViaN8n({
      message: result.data.content,
      department: result.data.department ?? null,
      orgId: payload.orgId,
      sessionId: id,
      history,
      plan,
      aiEngineUrl,
    });

    if (n8nResult) {
      aiResponse = n8nResult;
      console.log('[chat] responded via n8n cloud');
    } else {
      try {
        const res = await fetch(`${aiEngineUrl}/orchestrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: result.data.content,
            org_id: payload.orgId,
            session_id: id,
            department: result.data.department ?? null,
            plan,
          }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          console.error(`[chat] ai-engine returned ${res.status}: ${errBody}`);
          aiResponse = {
            content: `AI処理でエラーが発生しました (${res.status})。GROQ_API_KEYが正しく設定されているか確認してください。`,
            department: result.data.department ?? 'GENERAL',
          };
        } else {
          const json = await res.json() as { content: string; department: string };
          aiResponse = { content: json.content, department: json.department ?? 'GENERAL' };
          console.log('[chat] responded via ai-engine (fallback)');
        }
      } catch (err) {
        console.error('[chat] ai-engine connection error:', err);
        aiResponse = {
          content: 'AIエンジンに接続できません。サービスが起動しているか確認してください。',
          department: result.data.department ?? 'GENERAL',
        };
      }
    }

    const assistantMessage = await prisma.message.create({
      data: {
        sessionId: id,
        role: 'assistant',
        content: aiResponse.content,
        department: aiResponse.department,
      },
    });

    if (!session.title) {
      const title = result.data.content.slice(0, 30);
      await prisma.chatSession.update({ where: { id }, data: { title } });
    }

    return reply.send({ success: true, data: { userMessage, assistantMessage } });
  });

  // SSE ストリーミングエンドポイント
  app.post('/sessions/:id/messages/stream', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const payload = request.user as { sub: string; orgId: string };

    const body = sendMessageSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: body.error.message },
      });
    }

    const session = await prisma.chatSession.findUnique({ where: { id } });
    if (!session || session.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'セッションが見つかりません' } });
    }

    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';

    const userMessage = await prisma.message.create({
      data: { sessionId: id, role: 'user', content: body.data.content },
    });

    if (!session.title) {
      const title = body.data.content.slice(0, 30);
      await prisma.chatSession.update({ where: { id }, data: { title } });
    }

    // SSE ヘッダー
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': request.headers.origin || process.env.FRONTEND_URL?.split(',')[0] || '*',
      'Access-Control-Allow-Credentials': 'true',
    });

    reply.raw.write(`data: ${JSON.stringify({ type: 'userMessage', data: userMessage })}\n\n`);

    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://ai-engine:8000';
    let fullContent = '';
    let department = body.data.department ?? 'GENERAL';

    try {
      const res = await fetch(`${aiEngineUrl}/orchestrate/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: body.data.content,
          org_id: payload.orgId,
          session_id: id,
          department: body.data.department ?? null,
          plan,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`ai-engine returned ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as { type: string; content?: string; department?: string; message?: string };
            if (event.type === 'token' && event.content) {
              fullContent += event.content;
              reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: event.content })}\n\n`);
            } else if (event.type === 'department' && event.department) {
              department = event.department;
              reply.raw.write(`data: ${JSON.stringify({ type: 'department', department: event.department })}\n\n`);
            } else if (event.type === 'error') {
              reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: event.message })}\n\n`);
            }
          } catch { /* skip malformed JSON */ }
        }
      }
      console.log('[chat-stream] responded via ai-engine streaming');
    } catch (err) {
      console.error('[chat-stream] ai-engine stream failed, trying n8n fallback:', err);
      const orgRow = await prisma.organization.findUnique({ where: { id: payload.orgId }, select: { plan: true } });
      const n8nResult = await generateViaN8n({
        message: body.data.content,
        department: body.data.department ?? null,
        orgId: payload.orgId,
        sessionId: id,
        history: [],
        plan: orgRow?.plan ?? 'STARTER',
        aiEngineUrl: process.env.AI_ENGINE_URL ?? 'http://ai-engine:8000',
      });
      if (n8nResult) {
        fullContent = n8nResult.content;
        department = n8nResult.department;
        reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: fullContent })}\n\n`);
        console.log('[chat-stream] responded via n8n fallback');
      } else {
        fullContent = 'AIエンジンに接続できません。サービスが起動しているか確認してください。';
        reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: fullContent })}\n\n`);
      }
    }

    const assistantMessage = await prisma.message.create({
      data: { sessionId: id, role: 'assistant', content: fullContent, department },
    });

    reply.raw.write(`data: ${JSON.stringify({ type: 'done', data: assistantMessage })}\n\n`);
    reply.raw.end();
  });

  app.get('/sessions/:id/messages', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const payload = request.user as { orgId: string };

    const session = await prisma.chatSession.findUnique({ where: { id } });
    if (!session || session.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'セッションが見つかりません' } });
    }

    const messages = await prisma.message.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send({ success: true, data: messages });
  });

  /**
   * 会話が「繰り返し使える定型業務」に育ったか判定し、エージェント化のドラフトを返す。
   * 既存の AI Engine `/plan/agent` を会話全体に対して再利用する。過剰提案を避けるため
   * ・ユーザー発話が 2 往復未満なら提案しない
   * ・confidence が低い / name・instructions が欠けるなら提案しない。
   * 失敗時は常に suggest:false（チャット体験を阻害しない）。
   */
  app.post('/sessions/:id/suggest', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const payload = request.user as { orgId: string };

    const session = await prisma.chatSession.findUnique({ where: { id } });
    if (!session || session.orgId !== payload.orgId) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'セッションが見つかりません' } });
    }

    const recent = await prisma.message.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });
    const ordered = recent.reverse();
    const userTurns = ordered.filter((m) => m.role === 'user').length;
    if (userTurns < 2) {
      return reply.send({ success: true, data: { suggest: false } });
    }

    const org = await prisma.organization.findUnique({ where: { id: payload.orgId } });
    const plan = org?.plan ?? 'STARTER';

    const transcript = ordered
      .map((m) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content.slice(0, 800)}`)
      .join('\n');
    const description =
      '次のチャット会話の内容を、繰り返し使える業務エージェントとして設計してください。' +
      '会話の目的・対象・手順を汲み取り、エージェントの名前・部署・指示(システムプロンプト)を日本語で提案してください。' +
      `\n\n[会話]\n${transcript}`;

    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://ai-engine:8000';
    try {
      const res = await fetch(`${aiEngineUrl}/plan/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, org_id: payload.orgId, plan, available_capabilities: [] }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) return reply.send({ success: true, data: { suggest: false } });
      const draft = (await res.json()) as {
        name?: string | null;
        department?: string;
        instructions?: string | null;
        trigger?: string;
        confidence?: number;
        reasoning?: string;
      };
      const ok = !!draft.name && !!draft.instructions && (draft.confidence ?? 0) >= 0.6;
      if (!ok) return reply.send({ success: true, data: { suggest: false } });
      return reply.send({
        success: true,
        data: {
          suggest: true,
          kind: 'agent',
          draft: {
            name: draft.name,
            department: draft.department ?? 'GENERAL',
            instructions: draft.instructions,
            trigger: draft.trigger === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL',
            reasoning: draft.reasoning ?? '',
          },
        },
      });
    } catch {
      return reply.send({ success: true, data: { suggest: false } });
    }
  });
}
