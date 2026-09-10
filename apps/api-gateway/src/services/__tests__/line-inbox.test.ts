import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LineWebhookEvent } from '../inbox/line-types';

process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars';

const prismaMock = {
  channelConnection: { update: vi.fn() },
  inboundMessage: { create: vi.fn(), update: vi.fn() },
  organization: { findUnique: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const generateInboxDraftMock = vi.fn();
vi.mock('../inbox/draft-generator', () => ({ generateInboxDraft: generateInboxDraftMock }));

const getSenderProfileMock = vi.fn();
vi.mock('../inbox/line-client', () => ({ getSenderProfile: getSenderProfileMock }));

const captureReceiptMock = vi.fn();
vi.mock('../inbox/receipt-capture', () => ({
  captureReceiptFromLine: (...args: unknown[]) => captureReceiptMock(...args),
}));

vi.mock('../secret-box', () => ({
  openSecret: vi.fn(() => 'decrypted-access-token'),
  sealSecret: vi.fn(),
}));

const { processLineEvents, stripMentions } = await import('../inbox/line-inbox');

const CONNECTION = { id: 'conn1', orgId: 'org1', accessTokenEnc: 'enc' };

function groupTextEvent(over: Partial<LineWebhookEvent> = {}): LineWebhookEvent {
  return {
    type: 'message',
    webhookEventId: 'evt-1',
    timestamp: 1757300000000,
    source: { type: 'group', groupId: 'G1', userId: 'U1' },
    message: {
      id: 'msg-1',
      type: 'text',
      text: '@Bot 見積もりをください',
      mention: { mentionees: [{ index: 0, length: 4, type: 'user', isSelf: true }] },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.channelConnection.update.mockResolvedValue({});
  prismaMock.inboundMessage.create.mockResolvedValue({ id: 'm1' });
  prismaMock.inboundMessage.update.mockResolvedValue({});
  prismaMock.organization.findUnique.mockResolvedValue({ plan: 'PRO' });
  captureReceiptMock.mockResolvedValue({ summary: '📷 領収書', costEntryId: null });
  generateInboxDraftMock.mockResolvedValue(undefined);
  getSenderProfileMock.mockResolvedValue('田中');
});

describe('processLineEvents', () => {
  it('group テキスト + ボット宛メンション → RECEIVED で取り込み、下書き生成を起動する', async () => {
    await processLineEvents(CONNECTION, [groupTextEvent()]);

    expect(prismaMock.inboundMessage.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.inboundMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      orgId: 'org1',
      connectionId: 'conn1',
      provider: 'line',
      webhookEventId: 'evt-1',
      sourceType: 'group',
      groupId: 'G1',
      lineUserId: 'U1',
      senderName: '田中',
      messageType: 'text',
      text: '見積もりをください', // メンション除去済み
      status: 'RECEIVED',
    });
    expect(data.receivedAt).toEqual(new Date(1757300000000));
    expect(generateInboxDraftMock).toHaveBeenCalledWith('m1');
  });

  it('group テキストでもメンション無し → 取り込まない', async () => {
    const ev = groupTextEvent();
    delete ev.message!.mention;
    await processLineEvents(CONNECTION, [ev]);
    expect(prismaMock.inboundMessage.create).not.toHaveBeenCalled();
    expect(generateInboxDraftMock).not.toHaveBeenCalled();
  });

  it('@all のみのメンション → 取り込まない', async () => {
    const ev = groupTextEvent();
    ev.message!.mention = { mentionees: [{ index: 0, length: 4, type: 'all' }] };
    await processLineEvents(CONNECTION, [ev]);
    expect(prismaMock.inboundMessage.create).not.toHaveBeenCalled();
  });

  it('1:1 (user) のテキストはメンション不要で全件取り込む', async () => {
    const ev = groupTextEvent({
      source: { type: 'user', userId: 'U9' },
      message: { id: 'msg-2', type: 'text', text: 'こんにちは' },
    });
    await processLineEvents(CONNECTION, [ev]);
    const data = prismaMock.inboundMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ sourceType: 'user', groupId: null, lineUserId: 'U9', text: 'こんにちは', status: 'RECEIVED' });
  });

  it('P2002 (webhookEventId 重複 = LINE 再送) → 静かに skip し下書き生成もしない', async () => {
    prismaMock.inboundMessage.create.mockRejectedValue({ code: 'P2002' });
    await expect(processLineEvents(CONNECTION, [groupTextEvent()])).resolves.toBeUndefined();
    expect(generateInboxDraftMock).not.toHaveBeenCalled();
  });

  it('1:1 の画像は領収書として取り込み、読み取りに回す', async () => {
    // 現場から紙が来る問題に直接効く唯一の経路。捨てずに読む
    const userImage = groupTextEvent({
      webhookEventId: 'evt-img-u',
      source: { type: 'user', userId: 'U9' },
      message: { id: 'msg-4', type: 'image' },
    });
    await processLineEvents(CONNECTION, [userImage]);

    const data = prismaMock.inboundMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      webhookEventId: 'evt-img-u',
      sourceType: 'user',
      messageType: 'image',
      // ⚠️ RECEIVED だと受信箱が「返信の下書きを生成中」と解釈し、
      //    返信欄が出たまま永久に対応待ちに滞留する
      status: 'CAPTURED',
    });
    // テキスト用の下書き生成には回さない
    expect(generateInboxDraftMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(captureReceiptMock).toHaveBeenCalledTimes(1));
    expect(captureReceiptMock.mock.calls[0][0]).toMatchObject({ orgId: 'org1', messageId: 'msg-4' });
  });

  it('group の画像は無視する（@メンション判定ができないため）', async () => {
    const groupImage = groupTextEvent({
      webhookEventId: 'evt-img-g',
      message: { id: 'msg-3', type: 'image' },
    });
    await processLineEvents(CONNECTION, [groupImage]);
    expect(prismaMock.inboundMessage.create).not.toHaveBeenCalled();
    expect(captureReceiptMock).not.toHaveBeenCalled();
  });

  it('画像以外の非テキスト（スタンプ等）は SKIPPED のまま', async () => {
    const sticker = groupTextEvent({
      webhookEventId: 'evt-sticker',
      source: { type: 'user', userId: 'U9' },
      message: { id: 'msg-5', type: 'sticker' },
    });
    await processLineEvents(CONNECTION, [sticker]);

    expect(prismaMock.inboundMessage.create.mock.calls[0][0].data).toMatchObject({
      messageType: 'sticker',
      status: 'SKIPPED',
    });
    expect(captureReceiptMock).not.toHaveBeenCalled();
  });

  it('読み取りが失敗しても取り込みは残す（人が手入力できる状態を保つ）', async () => {
    captureReceiptMock.mockRejectedValueOnce(new Error('vision down'));
    const userImage = groupTextEvent({
      webhookEventId: 'evt-img-fail',
      source: { type: 'user', userId: 'U9' },
      message: { id: 'msg-6', type: 'image' },
    });

    await expect(processLineEvents(CONNECTION, [userImage])).resolves.toBeUndefined();
    await vi.waitFor(() => expect(prismaMock.inboundMessage.update).toHaveBeenCalled());
    expect(prismaMock.inboundMessage.update.mock.calls[0][0].data.text).toContain('失敗');
  });

  it('leave イベント → InboundMessage を作らない', async () => {
    await processLineEvents(CONNECTION, [
      { type: 'leave', webhookEventId: 'evt-leave', timestamp: 1, source: { type: 'group', groupId: 'G1' } },
    ]);
    expect(prismaMock.inboundMessage.create).not.toHaveBeenCalled();
  });

  it('lastEventAt を best-effort で更新する（失敗しても取り込みは続く）', async () => {
    prismaMock.channelConnection.update.mockRejectedValue(new Error('db down'));
    await processLineEvents(CONNECTION, [groupTextEvent()]);
    expect(prismaMock.channelConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conn1' } }),
    );
    expect(prismaMock.inboundMessage.create).toHaveBeenCalledTimes(1);
  });
});

describe('stripMentions', () => {
  it('index/length を降順に除去して位置ズレしない', () => {
    // 'AA BBB world' から [0,2) と [3,6) を除去 → ' world' → trim
    const out = stripMentions('AA BBB world', [
      { index: 0, length: 2 },
      { index: 3, length: 3 },
    ]);
    expect(out).toBe('world');
  });

  it('末尾側のメンションも正しく除去する', () => {
    const out = stripMentions('返信ください @Bot', [{ index: 7, length: 4, isSelf: true }]);
    expect(out).toBe('返信ください');
  });

  it('mentionees 無しは trim のみ', () => {
    expect(stripMentions('  こんにちは  ', undefined)).toBe('こんにちは');
  });

  it('範囲外の index/length は無視する', () => {
    expect(stripMentions('abc', [{ index: 1, length: 100 }])).toBe('abc');
  });
});
