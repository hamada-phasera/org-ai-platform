import { describe, it, expect } from 'vitest';
import { looksLikeApiSpec } from '../apiSpecDetect';

describe('looksLikeApiSpec', () => {
  it('curl コマンドは拾う', () => {
    expect(
      looksLikeApiSpec('curl https://api.example.com/v1/deals -H "Authorization: Bearer xxx"'),
    ).toBe(true);
    // 行頭でなくても拾う（説明文のあとに貼られることが多い）
    expect(looksLikeApiSpec('これで取れます:\ncurl -X POST https://api.example.com/v1/items')).toBe(true);
  });

  it('URL と認証ヘッダが揃っていれば拾う（curl でなくても）', () => {
    expect(
      looksLikeApiSpec('GET https://api.example.com/v1/customers\nX-API-Key: 必須です'),
    ).toBe(true);
    expect(
      looksLikeApiSpec('エンドポイントは https://api.example.com/v1/me で、api_key が必要です'),
    ).toBe(true);
  });

  it('⚠️ 普通の会話は拾わない（毎回 LLM 往復を挟むと体験が悪化する）', () => {
    expect(looksLikeApiSpec('来週の月曜までに見積書を作ってください。金額は税抜120万円です。')).toBe(false);
    expect(looksLikeApiSpec('この資料を要約して、слайдにまとめてください。よろしくお願いします。')).toBe(false);
  });

  it('URL だけでは拾わない（ただのリンク共有）', () => {
    expect(
      looksLikeApiSpec('資料はこちらです https://example.com/docs/getting-started を見てください'),
    ).toBe(false);
  });

  it('認証の話だけでも拾わない（URL が無い）', () => {
    expect(looksLikeApiSpec('APIキーの管理ってどうするのがいいんでしょうか。教えてください。')).toBe(false);
  });

  it('エッジ: 短すぎる文字列・非文字列で落ちない', () => {
    expect(looksLikeApiSpec('curl x')).toBe(false);
    expect(looksLikeApiSpec('')).toBe(false);
    expect(looksLikeApiSpec(undefined as unknown as string)).toBe(false);
    expect(looksLikeApiSpec(null as unknown as string)).toBe(false);
  });

  it('「curly」のような単語を curl と誤認しない', () => {
    expect(
      looksLikeApiSpec('curlyブラケットの書き方について教えてください。よく間違えてしまいます。'),
    ).toBe(false);
  });
});
