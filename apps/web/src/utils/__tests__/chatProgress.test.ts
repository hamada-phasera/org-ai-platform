import { describe, it, expect } from 'vitest';
import {
  CHAT_PHASES,
  isChatPhase,
  isStalled,
  phaseDetail,
  phaseLabel,
  STALLED_AFTER_MS,
} from '../chatProgress';

describe('phaseLabel', () => {
  it('4フェーズすべてに日本語ラベルがある', () => {
    for (const p of CHAT_PHASES) {
      expect(phaseLabel(p)).not.toBe('');
      expect(phaseLabel(p)).not.toContain('undefined');
    }
  });

  it('未開始（null）でも文言が出る', () => {
    expect(phaseLabel(null)).toBe('準備しています');
  });

  it('知らないフェーズが来ても壊れない（サーバ先行デプロイ）', () => {
    expect(phaseLabel('SOMETHING_NEW' as never)).toBe('処理しています');
  });

  it('「まもなく表示します」は FINALIZING だけ', () => {
    // ⚠️ 生成中に出すと推測になり、長引いたときに画面が嘘をつく
    const soon = CHAT_PHASES.filter((p) => phaseLabel(p).includes('まもなく'));
    expect(soon).toEqual(['FINALIZING']);
  });
});

describe('phaseDetail', () => {
  it('生成中だけ文字数を添える', () => {
    expect(phaseDetail('GENERATING', 320)).toBe('約320文字');
    expect(phaseDetail('GENERATING', 12345)).toBe('約12,345文字');
  });

  it('他のフェーズでは出さない', () => {
    expect(phaseDetail('RECEIVED', 320)).toBeNull();
    expect(phaseDetail('RETRIEVING', 320)).toBeNull();
    expect(phaseDetail('FINALIZING', 320)).toBeNull();
  });

  it('0文字・未取得では出さない', () => {
    expect(phaseDetail('GENERATING', 0)).toBeNull();
    expect(phaseDetail('GENERATING', null)).toBeNull();
  });

  it('⚠️ 進捗率は出さない（全体の長さが分からないので % は必ず嘘になる）', () => {
    for (const p of CHAT_PHASES) {
      const d = phaseDetail(p, 500);
      if (d !== null) expect(d).not.toContain('%');
    }
  });
});

describe('isStalled', () => {
  it('無通信が続いたら true', () => {
    const t0 = 1_000_000;
    expect(isStalled(t0, t0 + STALLED_AFTER_MS - 1)).toBe(false);
    expect(isStalled(t0, t0 + STALLED_AFTER_MS + 1)).toBe(true);
  });

  it('まだ1件もイベントが来ていなければ判定しない', () => {
    expect(isStalled(null, 9_999_999)).toBe(false);
  });
});

describe('isChatPhase', () => {
  it('既知のフェーズだけ通す', () => {
    expect(isChatPhase('GENERATING')).toBe(true);
    expect(isChatPhase('BOGUS')).toBe(false);
    expect(isChatPhase(null)).toBe(false);
    expect(isChatPhase(3)).toBe(false);
  });
});
