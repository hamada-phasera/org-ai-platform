// LINE webhook イベントの取り込み本体。
// webhook ルートは即 200 を返し、本モジュールを void 非同期で呼ぶ（LINE の再送を誘発しない）。
// dedupe は (provider, webhookEventId) unique 制約が本体で、P2002 を静かに握る。
// replyToken は使わない・保存しない（承認 API が push で送信する）。

import { prisma } from '../../utils/prisma';
import { openSecret } from '../secret-box';
import { getSenderProfile } from './line-client';
import { generateInboxDraft } from './draft-generator';
import type { LineMentionee, LineWebhookEvent } from './line-types';
import { captureReceiptFromLine } from './receipt-capture';

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
  /**
   * RECEIVED = 返信の下書きを生成する対象
   * SKIPPED  = 対応できない受信（スタンプ等）
   * CAPTURED = 領収書として読み取り済み。返信するものではなく、次の操作は 経理 > 原価
   */
  status: 'RECEIVED' | 'SKIPPED' | 'CAPTURED';
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
 * 画像を領収書として読み取り、結果を受信メッセージの本文に書き戻す。
 *
 * 完全に best-effort。失敗しても受信そのものは残す（人が手入力できる状態を保つ）。
 * ⚠️ 例外を上へ投げない。webhook の取り込みループを止めてはいけない。
 */
async function captureReceipt(
  connection: InboxConnection,
  messageId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: connection.orgId },
      select: { plan: true },
    });
    const result = await captureReceiptFromLine({
      orgId: connection.orgId,
      plan: org?.plan ?? 'STARTER',
      accessToken: openSecret(connection.accessTokenEnc),
      messageId,
    });
    // status は作成時から CAPTURED。ここでは読み取り結果の本文だけを書き戻す
    await prisma.inboundMessage.update({
      where: { id: inboundMessageId },
      data: { text: result.summary },
    });
  } catch (e) {
    // ⚠️ e の中身をそのまま出さない（アクセストークンや messageId が混ざりうる）
    console.error('[line-inbox] 領収書の読み取りに失敗しました');
    if (process.env.NODE_ENV !== 'production') {
      console.error(e instanceof Error ? e.message : e);
    }
    await prisma.inboundMessage
      .update({
        where: { id: inboundMessageId },
        data: { text: '📷 領収書を受け取りましたが、読み取りに失敗しました。' },
      })
      .catch(() => null);
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
        if (sourceType === 'user' && event.message.type === 'image' && event.message.id) {
          // 1:1 の画像は領収書として読み取る。現場から紙が来る問題に直接効く唯一の経路で、
          // 「LINE に送るだけ＝入力項目ゼロ」がこの機能の価値そのもの。
          // ⚠️ 画像は保存しない。読み取った値だけを残す。
          const created = await createInboundMessage({
            connection,
            event,
            sourceType,
            groupId,
            lineUserId,
            senderName: null,
            messageType: 'image',
            text: null,
            // ⚠️ RECEIVED にしてはいけない。受信箱は RECEIVED を「返信の下書きを生成中」と
            //    解釈するので、返信欄が出たまま永久に対応待ちに滞留する（この画像に返信はしない）
            status: 'CAPTURED',
          });
          if (created) {
            // 読み取りは完全非同期（webhook 応答にも取り込みループにも影響させない）。
            // LINE は 1 分以内に 200 を返さないと再送してくるので、ここで待たない。
            void captureReceipt(connection, event.message.id, created.id);
          }
          continue;
        }
        if (sourceType === 'user') {
          // 画像以外の 1:1 非テキストは「対応できない受信があった」ことだけ記録する。
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
