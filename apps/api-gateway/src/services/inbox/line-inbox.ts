// LINE webhook イベントの取り込み本体。
// webhook ルートは即 200 を返し、本モジュールを void 非同期で呼ぶ（LINE の再送を誘発しない）。
// dedupe は (provider, webhookEventId) unique 制約が本体で、P2002 を静かに握る。
// replyToken は使わない・保存しない（承認 API が push で送信する）。

import { prisma } from '../../utils/prisma';
import { openSecret } from '../secret-box';
import { getSenderProfile } from './line-client';
import { generateInboxDraft } from './draft-generator';
import type { LineMentionee, LineWebhookEvent } from './line-types';

/** processLineEvents が必要とする最小形（Prisma の ChannelConnection 互換）。 */
export interface InboxConnection {
  id: string;
  orgId: string;
  accessTokenEnc: string;
}

/**
 * メンション部分（"@bot " 等）を本文から除去する。
 * index/length は元テキスト上のオフセットなので、降順に除去して位置ズレを防ぐ。
 */
export function stripMentions(text: string, mentionees: LineMentionee[] | undefined): string {
  if (!mentionees || mentionees.length === 0) return text.trim();
  let out = text;
  const sorted = [...mentionees].sort((a, b) => b.index - a.index);
  for (const m of sorted) {
    if (m.index < 0 || m.length <= 0 || m.index + m.length > out.length) continue;
    out = out.slice(0, m.index) + out.slice(m.index + m.length);
  }
  return out.trim();
}

/** このボット宛のメンションが含まれるか（@all は宛先扱いしない）。 */
function isBotMentioned(mentionees: LineMentionee[] | undefined): boolean {
  return mentionees?.some((m) => m.type !== 'all' && m.isSelf === true) ?? false;
}

interface CreateArgs {
  connection: InboxConnection;
  event: LineWebhookEvent;
  sourceType: string;
  groupId: string | null;
  lineUserId: string | null;
  senderName: string | null;
  messageType: string;
  text: string | null;
  status: 'RECEIVED' | 'SKIPPED';
}

/** InboundMessage を作成する。webhookEventId 重複 (P2002 = LINE 再送) は静かに skip して null。 */
async function createInboundMessage(args: CreateArgs): Promise<{ id: string } | null> {
  try {
    return await prisma.inboundMessage.create({
      data: {
        orgId: args.connection.orgId,
        connectionId: args.connection.id,
        provider: 'line',
        webhookEventId: args.event.webhookEventId,
        sourceType: args.sourceType,
        groupId: args.groupId,
        lineUserId: args.lineUserId,
        senderName: args.senderName,
        messageType: args.messageType,
        text: args.text,
        status: args.status,
        receivedAt: new Date(args.event.timestamp),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      // LINE の再送。unique (provider, webhookEventId) による dedupe の本体。
      return null;
    }
    throw e;
  }
}

/**
 * webhook で受けたイベント列を InboundMessage に取り込み、テキストは下書き生成に回す。
 * - group / room: ボット宛メンション付きテキストのみ取り込む
 * - user (1:1): 全テキストを取り込む。非テキストは SKIPPED として記録
 * - 非テキスト group / room: 無視（LINE は非テキストに mention フィールドを持たず@判定不能のため）
 */
export async function processLineEvents(
  connection: InboxConnection,
  events: LineWebhookEvent[],
): Promise<void> {
  // 最終イベント時刻は接続の生存確認用メタデータ。失敗しても取り込みは続行する。
  try {
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: { lastEventAt: new Date() },
    });
  } catch (e) {
    console.error('[line-inbox] lastEventAt の更新に失敗:', e instanceof Error ? e.message : e);
  }

  for (const event of events) {
    try {
      if (event.type === 'leave') {
        console.log(
          `[line-inbox] bot left source (connection=${connection.id}, sourceType=${event.source?.type ?? 'unknown'})`,
        );
        continue;
      }
      if (event.type !== 'message' || !event.message || !event.source) continue;

      const source = event.source;
      const sourceType = source.type; // 'user' | 'group' | 'room'
      if (sourceType !== 'user' && sourceType !== 'group' && sourceType !== 'room') continue;
      const groupId = source.groupId ?? source.roomId ?? null;
      const lineUserId = source.userId ?? null;

      if (event.message.type !== 'text') {
        if (sourceType === 'user') {
          // 1:1 の非テキストは「対応できない受信があった」ことだけ記録する（下書き対象外）。
          await createInboundMessage({
            connection,
            event,
            sourceType,
            groupId,
            lineUserId,
            senderName: null,
            messageType: event.message.type,
            text: null,
            status: 'SKIPPED',
          });
        }
        // group / room の非テキストは無視。非テキストメッセージには mention フィールドが無く
        // ボット宛（@メンション）かどうか判定できないため、取り込むとノイズしか増えない。
        continue;
      }

      const mentionees = event.message.mention?.mentionees;
      if (sourceType !== 'user') {
        // group / room はボット宛メンション付きだけ拾う（@all は宛先扱いしない）
        if (!isBotMentioned(mentionees)) continue;
      }

      const text = stripMentions(event.message.text ?? '', mentionees);

      let senderName: string | null = null;
      try {
        senderName = await getSenderProfile(openSecret(connection.accessTokenEnc), source);
      } catch {
        senderName = null; // プロフィール取得は best-effort（復号失敗含む）
      }

      const created = await createInboundMessage({
        connection,
        event,
        sourceType,
        groupId,
        lineUserId,
        senderName,
        messageType: 'text',
        text,
        status: 'RECEIVED',
      });
      if (created) {
        // 下書き生成は完全非同期（webhook 応答にも取り込みループにも影響させない）
        void generateInboxDraft(created.id);
      }
    } catch (e) {
      console.error(
        `[line-inbox] event 処理に失敗 (webhookEventId=${event.webhookEventId}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}
