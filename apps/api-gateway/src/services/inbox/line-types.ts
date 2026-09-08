// LINE Messaging API webhook の最小型定義（SDK は使わない）。
// 必要なフィールドだけを型にし、未知のフィールドは無視する。
// https://developers.line.biz/ja/reference/messaging-api/#webhook-event-objects

export interface LineMentionee {
  index: number;
  length: number;
  /** 'user' | 'all'。'all'（@全員）はボット宛メンションとして扱わない。 */
  type?: string;
  userId?: string;
  /** メンション先がこのボット自身なら true（LINE が付与）。 */
  isSelf?: boolean;
}

export interface LineMention {
  mentionees: LineMentionee[];
}

export interface LineMessage {
  id: string;
  /** 'text' | 'image' | 'sticker' | ... */
  type: string;
  text?: string;
  mention?: LineMention;
}

export interface LineEventSource {
  /** 'user' | 'group' | 'room' */
  type: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineWebhookEvent {
  /** 'message' | 'leave' | 'join' | ... */
  type: string;
  /** LINE 再送 dedupe のキー（(provider, webhookEventId) unique）。 */
  webhookEventId: string;
  /** イベント発生時刻 (unix ms)。InboundMessage.receivedAt に使う。 */
  timestamp: number;
  deliveryContext?: { isRedelivery: boolean };
  source?: LineEventSource;
  message?: LineMessage;
}

export interface LineWebhookBody {
  /** 送信先ボットの userId。ChannelConnection.channelId の逆引きキー。 */
  destination: string;
  events: LineWebhookEvent[];
}
