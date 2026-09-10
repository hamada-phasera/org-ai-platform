// LINE 受信メッセージへの AI 返信下書き生成。
// LLM は AI Engine `/llm/chat` 経由（規約準拠・直接呼び出し禁止）。`/llm/chat` は AILog を
// 書かないため、本モジュールで prisma.aILog.create する（routes/sns/posts.ts の流儀を踏襲）。
// 下書きは InboundMessage.draft に保存し、status を DRAFTED / DRAFT_FAILED に遷移させる。
// 実送信は絶対にしない（送信は承認 API → adapter.sendReply だけ）。

import { prisma } from '../../utils/prisma';
import { aiEngineHeaders } from '../ai-engine-auth';

const INBOX_DEPARTMENT = 'GENERAL';
const MAX_INPUT_CHARS = 4000;
const HISTORY_TAKE = 10;
const AI_TIMEOUT_MS = 30_000;

interface LLMChatResponse {
  content: string;
  model: string;
  tokens_used: number;
  latency_ms: number;
  pii_detected: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InboxHistoryEntry {
  /** 相手からの受信本文（古い順） */
  text: string | null;
  /** こちらが承認送信した返信本文 */
  replyText: string | null;
}

export interface InboxDraftContext {
  orgName: string;
  senderName: string | null;
  /** 返信対象の受信本文 */
  text: string;
  /** 同じ会話（connectionId + groupId）の直近履歴。古い順。 */
  history: InboxHistoryEntry[];
}

/** LLM への messages を組み立てる（pure・テスト対象）。 */
export function buildInboxDraftMessages(ctx: InboxDraftContext): ChatMessage[] {
  const system =
    `あなたは${ctx.orgName}のLINE公式アカウントの返信担当。` +
    '丁寧・簡潔な日本語で1通の返信文だけを作る。絵文字は控えめ。' +
    '不明・判断できない点は正直に確認を促す。' +
    '出力は JSON {"reply":"..."} のみ。';

  const lines: string[] = [];
  for (const h of ctx.history) {
    if (h.text) lines.push(`相手: ${h.text}`);
    if (h.replyText) lines.push(`返信: ${h.replyText}`);
  }
  const transcript = lines.length > 0 ? lines.join('\n') : '（履歴なし）';

  const user =
    `## これまでの会話\n${transcript}\n\n` +
    `## 返信すべきメッセージ（${ctx.senderName ?? '不明'}さんより）\n${ctx.text.slice(0, MAX_INPUT_CHARS)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * LLM 応答本文から {"reply": "..."} を取り出す（pure・テスト対象）。
 * routes/sns/posts.ts の parseDraftBody と同型: JSON でなければ全文フォールバック。
 * コードフェンス（```json ... ```）にも耐える。
 */
export function parseReplyBody(raw: string): string {
  const trimmed = raw.trim();
  // ```json ... ``` / ``` ... ``` を剥がす
  const unfenced = trimmed.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  try {
    const j = JSON.parse(unfenced) as { reply?: unknown };
    if (typeof j.reply === 'string' && j.reply.trim()) {
      return j.reply;
    }
  } catch {
    /* JSON でない場合は全文を返信文として扱う（フォールバック） */
  }
  return trimmed;
}

/**
 * InboundMessage(id) の返信下書きを生成して DRAFTED / DRAFT_FAILED に更新する。
 * 既定では RECEIVED の行だけを対象にし、それ以外は上書きしない
 * （regenerate 経由 = allowRegenerate:true のときのみ RECEIVED/DRAFTED/DRAFT_FAILED を許可）。
 * void 呼び出し前提のため、内部で throw しない。
 */
export async function generateInboxDraft(
  id: string,
  opts: { allowRegenerate?: boolean } = {},
): Promise<void> {
  try {
    const msg = await prisma.inboundMessage.findUnique({ where: { id } });
    if (!msg || !msg.text) return;
    const allowed = opts.allowRegenerate
      ? ['RECEIVED', 'DRAFTED', 'DRAFT_FAILED']
      : ['RECEIVED'];
    if (!allowed.includes(msg.status)) return;

    const org = await prisma.organization.findUnique({ where: { id: msg.orgId } });
    const plan = org?.plan ?? 'STARTER';

    // 同じ会話の直近履歴（古い順に整形）。
    // 1:1（groupId=null）は同一 connection 上の別ユーザーの会話が混ざらないよう lineUserId でも絞る。
    const historyRows = await prisma.inboundMessage.findMany({
      where: {
        connectionId: msg.connectionId,
        groupId: msg.groupId,
        ...(msg.groupId === null && msg.lineUserId ? { lineUserId: msg.lineUserId } : {}),
        id: { not: msg.id },
      },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TAKE,
    });
    const history = historyRows
      .reverse()
      .map((h) => ({ text: h.text, replyText: h.replyText }));

    const messages = buildInboxDraftMessages({
      orgName: org?.name ?? '当社',
      senderName: msg.senderName,
      text: msg.text,
      history,
    });

    const aiEngineUrl = process.env.AI_ENGINE_URL ?? 'http://localhost:8000';
    let llm: LLMChatResponse;
    try {
      const res = await fetch(`${aiEngineUrl}/llm/chat`, {
        method: 'POST',
        headers: aiEngineHeaders(),
        body: JSON.stringify({
          messages,
          department: INBOX_DEPARTMENT,
          org_id: msg.orgId,
          plan,
          json_mode: true,
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`ai-engine ${res.status}: ${text.slice(0, 300)}`);
      }
      llm = JSON.parse(text) as LLMChatResponse;
    } catch (e) {
      await prisma.inboundMessage.update({
        where: { id },
        data: {
          status: 'DRAFT_FAILED',
          draftError: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        },
      });
      return;
    }

    const draft = parseReplyBody(llm.content ?? '');

    // AILog（必須・best-effort）。/llm/chat は AILog を書かないため gateway 側で記録する。
    try {
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      await prisma.aILog.create({
        data: {
          orgId: msg.orgId,
          department: INBOX_DEPARTMENT,
          provider: 'anthropic',
          model: llm.model,
          inputText: userPrompt.slice(0, MAX_INPUT_CHARS),
          outputText: (llm.content ?? '').slice(0, MAX_INPUT_CHARS),
          tokens: llm.tokens_used ?? null,
          latencyMs: llm.latency_ms ?? null,
          riskScore: null,
        },
      });
    } catch (e) {
      console.error('[inbox/draft] AILog 記録に失敗:', e instanceof Error ? e.message : e);
    }

    await prisma.inboundMessage.update({
      where: { id },
      data: {
        status: 'DRAFTED',
        draft,
        draftModel: llm.model ?? null,
        draftError: null,
      },
    });
  } catch (e) {
    // void 呼び出し前提: ここで握って unhandled rejection にしない
    console.error(`[inbox/draft] 下書き生成に失敗 (id=${id}):`, e instanceof Error ? e.message : e);
    try {
      await prisma.inboundMessage.update({
        where: { id },
        data: {
          status: 'DRAFT_FAILED',
          draftError: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        },
      });
    } catch {
      /* 二重障害は諦める（ログ済み） */
    }
  }
}
