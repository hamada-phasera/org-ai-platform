import { describe, it, expect } from 'vitest';
import { marginTone, percent, yen, yenShort } from '../types';

describe('yenShort', () => {
  it('万・億に畳む', () => {
    expect(yenShort(15_000)).toBe('2万円');
    expect(yenShort(12_345_678)).toBe('1,235万円');
    expect(yenShort(150_000_000)).toBe('1.5億円');
    expect(yenShort(9_999)).toBe('¥9,999');
  });

  it('⚠️ 赤字を小さく見せない（丸めは絶対値に対して行う）', () => {
    // Math.round は half を +∞ 方向に丸めるので、素直に書くと
    // -15,000 が「-1万円」、+15,000 が「2万円」になり損失だけ小さく出る
    expect(yenShort(-15_000)).toBe('-2万円');
    expect(yenShort(15_000)).toBe('2万円');
    expect(yenShort(-150_000_000)).toBe('-1.5億円');
  });

  it('符号を跨いで絶対値が対称になる', () => {
    for (const v of [15_000, 25_000, 12_345_678, 150_000_000]) {
      expect(yenShort(-v)).toBe(`-${yenShort(v)}`);
    }
  });

  it('0 とごく小さい額', () => {
    expect(yenShort(0)).toBe('¥0');
    expect(yenShort(-1)).toBe('¥-1');
  });
});

describe('marginTone', () => {
  it('赤字は danger、閾値割れは warning', () => {
    expect(marginTone(-0.1)).toBe('danger');
    expect(marginTone(0)).toBe('warning');
    expect(marginTone(9.9)).toBe('warning');
    expect(marginTone(10)).toBe('normal');
    expect(marginTone(30)).toBe('normal');
  });

  it('請負金額が未定（null）なら色を付けない', () => {
    expect(marginTone(null)).toBe('normal');
  });
});

describe('percent / yen', () => {
  it('null は「—」', () => {
    expect(percent(null)).toBe('—');
    expect(percent(30)).toBe('30%');
  });

  it('3桁区切り', () => {
    expect(yen(1_234_567)).toBe('¥1,234,567');
    expect(yen(0)).toBe('¥0');
  });
});
