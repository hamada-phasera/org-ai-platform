import { describe, it, expect } from 'vitest';
import {
  normalizeHashtags,
  countChars,
  validatePost,
  formatForClipboard,
  buildSnsMessages,
  isSnsPlatform,
  PLATFORM_CONSTRAINTS,
} from '../../src/routes/sns/format';

describe('normalizeHashtags', () => {
  it('正常系: 先頭#除去・トリム・素のタグ配列を返す', () => {
    expect(normalizeHashtags(['#AI', 'Tech'])).toEqual(['AI', 'Tech']);
  });

  it('エッジ: 空白/空/重複(大小無視)/内部空白/不可記号を整形', () => {
    const out = normalizeHashtags(['#AI', 'ai', ' Tech ', '##Marketing', 'multi word', '   ', '#', undefined, null]);
    // 'ai' は 'AI' と重複(大小無視)で除外、空/記号のみは除外、内部空白は除去
    expect(out).toEqual(['AI', 'Tech', 'Marketing', 'multiword']);
  });

  it('エッジ: 入力なしは空配列', () => {
    expect(normalizeHashtags(undefined)).toEqual([]);
  });
});

describe('countChars', () => {
  it('正常系: 本文 + Σ(タグ長+2)', () => {
    expect(countChars('hello', ['ai', 'tech'])).toBe(5 + (2 + 2) + (4 + 2)); // 15
    expect(countChars('abc', [])).toBe(3);
  });
});

describe('validatePost', () => {
  it('正常系: X(280)以内は ok', () => {
    const v = validatePost('twitter', 'a'.repeat(100), ['ai']);
    expect(v.ok).toBe(true);
    expect(v.charCount).toBe(100 + (2 + 2)); // 'ai'(2) + '#'と区切りで +2 = 104
    expect(v.overBy).toBe(0);
  });

  it('エッジ: X は280超過で ok=false / overBy を返す', () => {
    const v = validatePost('twitter', 'a'.repeat(279), ['x']); // 279 + (1+2)=282
    expect(v.ok).toBe(false);
    expect(v.overBy).toBe(2);
  });

  it('エッジ: Instagram はハッシュタグ31個で ok=false（文字数OKでも）', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `t${i}`);
    const v = validatePost('instagram', '短い本文', tags);
    expect(v.hashtagCount).toBe(31);
    expect(v.maxHashtags).toBe(30);
    expect(v.ok).toBe(false);
  });

  it('X はハッシュタグ上限なし(maxHashtags=null)', () => {
    expect(PLATFORM_CONSTRAINTS.twitter.maxHashtags).toBeNull();
    const v = validatePost('twitter', 'a', Array.from({ length: 40 }, (_, i) => `t${i}`.padEnd(1, 'x')));
    // タグ数では落ちない（文字数だけで判定）
    expect(v.maxHashtags).toBeNull();
  });
});

describe('formatForClipboard', () => {
  it('正常系: 本文 + 改行2 + #付きタグ', () => {
    expect(formatForClipboard('本文', ['ai', 'tech'])).toBe('本文\n\n#ai #tech');
  });
  it('エッジ: タグ無しは本文のみ', () => {
    expect(formatForClipboard('本文', [])).toBe('本文');
  });
});

describe('buildSnsMessages', () => {
  it('正常系: system に文字数上限・JSON出力指示、user にテーマ', () => {
    const messages = buildSnsMessages('instagram', { topic: '新商品の告知', tone: '明るく' });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('2200'); // Instagram の上限
    expect(messages[0].content).toContain('JSON');
    expect(messages[1].content).toContain('新商品の告知');
    expect(messages[1].content).toContain('明るく');
  });
});

describe('isSnsPlatform', () => {
  it('正常系/エッジ', () => {
    expect(isSnsPlatform('twitter')).toBe(true);
    expect(isSnsPlatform('facebook')).toBe(false);
    expect(isSnsPlatform(undefined)).toBe(false);
  });
});

describe('validatePost 境界値 (N-4)', () => {
  it('X: ちょうど280はOK、281はNG', () => {
    expect(validatePost('twitter', 'a'.repeat(280), []).ok).toBe(true);
    const over = validatePost('twitter', 'a'.repeat(281), []);
    expect(over.ok).toBe(false);
    expect(over.overBy).toBe(1);
  });

  it('Instagram: ハッシュタグちょうど30はOK、31はNG', () => {
    const tags30 = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(validatePost('instagram', '本文', tags30).ok).toBe(true);
    expect(validatePost('instagram', '本文', [...tags30, 't30']).ok).toBe(false);
  });

  it('文字数は本文+タグ(#と空白で+2/個)。絵文字はUTF-16単位で数える', () => {
    // '😀' は length=2（サロゲートペア）
    expect(countChars('😀', [])).toBe(2);
    expect(countChars('ab', ['x'])).toBe(2 + (1 + 2));
  });
});

describe('N-4 追加エッジ（LinkedIn境界 / 空入力 / タグ内サロゲート）', () => {
  it('LinkedIn: ちょうど3000はOK、3001はNG', () => {
    expect(PLATFORM_CONSTRAINTS.linkedin.maxChars).toBe(3000);
    expect(validatePost('linkedin', 'a'.repeat(3000), []).ok).toBe(true);
    const over = validatePost('linkedin', 'a'.repeat(3001), []);
    expect(over.ok).toBe(false);
    expect(over.overBy).toBe(1);
  });

  it('空入力: 本文空・タグ空は charCount 0 で ok', () => {
    const v = validatePost('twitter', '', []);
    expect(v.charCount).toBe(0);
    expect(v.ok).toBe(true);
    expect(v.hashtagCount).toBe(0);
  });

  it('空白/記号のみのタグ配列は正規化で全除去され []', () => {
    expect(normalizeHashtags(['   ', '#', '', '###', '  #  '])).toEqual([]);
  });

  it('タグ内の絵文字(サロゲート)や不可記号は除去、素の語だけ残す', () => {
    // 絵文字は \p{L}/\p{N}/_ ではないので除去され 'ai' が残る
    expect(normalizeHashtags(['ai😀', '#新商品🎉', '🔥'])).toEqual(['ai', '新商品']);
  });

  it('countChars: マルチバイト本文もUTF-16単位（結合しないCJKは1/字）', () => {
    // CJK は各1コードユニット。'新商品告知'=5 + タグ'ai'(2)+2 = 9
    expect(countChars('新商品告知', ['ai'])).toBe(5 + (2 + 2));
  });
});
