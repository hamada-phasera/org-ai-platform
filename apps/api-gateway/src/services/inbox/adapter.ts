// 受信箱のチャネル抽象。現状 provider は 'line' のみだが、承認 API 側は
// ChannelAdapter 経由で送信することで、将来の provider 追加時にルートを触らずに済む。

import { createHash } from 'crypto';
import type { ChannelProvider } from '@org-ai/shared-types';
import { openSecret } from '../secret-box';
import { getQuotaConsumption, pushTextMessage, type PushResult } from './line-client';

/** アダプタが必要とする最小形（Prisma の ChannelConnection 互換）。 */
export interface ConnectionLike {
  accessTokenEnc: string;
}

/** アダプタが必要とする最小形（Prisma の InboundMessage 互換）。 */
export interface InboundMessageLike {
  id: string;
  /** group の groupId / room の roomId（1:1 は null） */
  groupId: string | null;
  lineUserId: string | null;
}

export interface ChannelAdapter {
  provider: ChannelProvider;
  sendReply(conn: ConnectionLike, msg: InboundMessageLike, text: string): Promise<PushResult>;
  fetchQuotaUsage(conn: ConnectionLike): Promise<number | null>;
}

/**
 * X-Line-Retry-Key は UUID 形式必須。メッセージ id から決定的に導出することで、
 * 同じ InboundMessage への承認リトライが LINE 側で二重送信にならないようにする。
 */
function retryKeyFor(messageId: string): string {
  const h = createHash('sha256').update(`inbox-reply:${messageId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const lineAdapter: ChannelAdapter = {
  provider: 'line',
  async sendReply(conn, msg, text) {
    const to = msg.groupId ?? msg.lineUserId;
    if (!to) {
      return { ok: false, status: 0, body: '送信先（groupId / lineUserId）がありません' };
    }
    const accessToken = openSecret(conn.accessTokenEnc);
    return pushTextMessage(accessToken, to, text, retryKeyFor(msg.id));
  },
  async fetchQuotaUsage(conn) {
    return getQuotaConsumption(openSecret(conn.accessTokenEnc));
  },
};

export function getChannelAdapter(provider: string): ChannelAdapter {
  if (provider === 'line') return lineAdapter;
  throw new Error(`unsupported channel provider: ${provider}`);
}
