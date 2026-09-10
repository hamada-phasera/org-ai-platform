import { describe, it, expect, vi } from 'vitest';

process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars';

// pure 関数のみ検証するが、対象モジュールが utils/prisma を import するためモック必須
// （utils/prisma は DATABASE_URL 未設定だと import 時に throw する）
const prismaMock = {
  inboundMessage: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  organization: { findUnique: vi.fn() },
  channelConnection: { findUnique: vi.fn(), update: vi.fn() },
  aILog: { create: vi.fn() },
};
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const { buildInboxDraftMessages, parseReplyBody } = await import('../inbox/draft-generator');
const { assertTransition } = await import('../../routes/inbox/messages');

describe('buildInboxDraftMessages', () => {
  it('system に org 名と JSON 出力指示、user に送信者名と本文を含む', () => {
    const [system, user] = buildInboxDraftMessages({
      orgName: '株式会社テスト',
      senderName: '田中',
      text: '納期を教えてください',
      history: [],
    });
    expect(system.role).toBe('system');
    expect(system.content).toContain('株式会社テスト');
    expect(system.content).toContain('{"reply":"..."}');
    expect(user.role).toBe('user');
    expect(user.content).toContain('田中さんより');
    expect(user.content).toContain('納期を教えてください');
    expect(user.content).toContain('（履歴なし）');
  });

  it('会話履歴を古い順（渡された順）に「相手:」「返信:」で並べる', () => {
    const [, user] = buildInboxDraftMessages({
      orgName: 'X',
      senderName: null,
      text: '最新の質問',
      history: [
        { text: '一番古い質問', replyText: '一番古い返信' },
        { text: '二番目の質問', replyText: null },
      ],
    });
    const iOldQ = user.content.indexOf('相手: 一番古い質問');
    const iOldR = user.content.indexOf('返信: 一番古い返信');
    const iNewQ = user.content.indexOf('相手: 二番目の質問');
    expect(iOldQ).toBeGreaterThan(-1);
    expect(iOldR).toBeGreaterThan(iOldQ);
    expect(iNewQ).toBeGreaterThan(iOldR);
    // senderName null → 不明
    expect(user.content).toContain('不明さんより');
  });

  it('入力本文は先頭 4000 字に切る', () => {
    const [, user] = buildInboxDraftMessages({
      orgName: 'X',
      senderName: null,
      text: 'あ'.repeat(5000),
      history: [],
    });
    const bodyPart = user.content.split('さんより）\n')[1];
    expect(bodyPart.length).toBe(4000);
  });
});

describe('parseReplyBody', () => {
  it('JSON {"reply": ...} から返信文を取り出す', () => {
    expect(parseReplyBody('{"reply":"承知しました。明日お送りします。"}')).toBe(
      '承知しました。明日お送りします。',
    );
  });

  it('コードフェンス付き JSON にも耐える', () => {
    expect(parseReplyBody('```json\n{"reply":"フェンス内の返信"}\n```')).toBe('フェンス内の返信');
    expect(parseReplyBody('```\n{"reply":"言語指定なし"}\n```')).toBe('言語指定なし');
  });

  it('JSON でなければ全文フォールバック', () => {
    expect(parseReplyBody('こんにちは、返信です。')).toBe('こんにちは、返信です。');
  });

  it('reply キーの無い JSON も全文フォールバック', () => {
    expect(parseReplyBody('{"answer":"x"}')).toBe('{"answer":"x"}');
  });
});

describe('assertTransition', () => {
  it('CAPTURED（領収書）はどの操作も受け付けない — 領収書に LINE 返信を送らせない', () => {
    // 画像は「返信する対象」ではない。次の操作は 経理 > 原価 での確定であって、
    // 受信箱からの返信ではない
    for (const action of ['regenerate', 'approve', 'reject'] as const) {
      expect(assertTransition('CAPTURED', action)).toBe(false);
    }
  });

  it('regenerate: RECEIVED/DRAFTED/DRAFT_FAILED のみ許可', () => {
    expect(assertTransition('RECEIVED', 'regenerate')).toBe(true);
    expect(assertTransition('DRAFTED', 'regenerate')).toBe(true);
    expect(assertTransition('DRAFT_FAILED', 'regenerate')).toBe(true);
    expect(assertTransition('SENT', 'regenerate')).toBe(false);
    expect(assertTransition('REJECTED', 'regenerate')).toBe(false);
    expect(assertTransition('SKIPPED', 'regenerate')).toBe(false);
    expect(assertTransition('SEND_FAILED', 'regenerate')).toBe(false);
  });

  it('approve: DRAFTED/DRAFT_FAILED/SEND_FAILED のみ許可', () => {
    expect(assertTransition('DRAFTED', 'approve')).toBe(true);
    expect(assertTransition('DRAFT_FAILED', 'approve')).toBe(true);
    expect(assertTransition('SEND_FAILED', 'approve')).toBe(true); // push 失敗のリトライ
    expect(assertTransition('RECEIVED', 'approve')).toBe(false);
    expect(assertTransition('SENT', 'approve')).toBe(false); // 二重送信防止
    expect(assertTransition('REJECTED', 'approve')).toBe(false);
  });

  it('reject: RECEIVED/DRAFTED/DRAFT_FAILED のみ許可', () => {
    expect(assertTransition('RECEIVED', 'reject')).toBe(true);
    expect(assertTransition('DRAFTED', 'reject')).toBe(true);
    expect(assertTransition('DRAFT_FAILED', 'reject')).toBe(true);
    expect(assertTransition('SENT', 'reject')).toBe(false);
    expect(assertTransition('SEND_FAILED', 'reject')).toBe(false);
    expect(assertTransition('SKIPPED', 'reject')).toBe(false);
  });
});
