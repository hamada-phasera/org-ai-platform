import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyLineSignature } from '../inbox/line-client';

const SECRET = 'test-channel-secret';
const RAW_BODY = Buffer.from(JSON.stringify({ destination: 'Uabc', events: [] }), 'utf8');

function goodSignature(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

describe('verifyLineSignature', () => {
  it('正しい HMAC-SHA256 署名 → true', () => {
    expect(verifyLineSignature(RAW_BODY, SECRET, goodSignature(RAW_BODY, SECRET))).toBe(true);
  });

  it('1 バイト改竄した署名 → false', () => {
    const digest = createHmac('sha256', SECRET).update(RAW_BODY).digest();
    digest[0] ^= 0xff; // 先頭バイトを反転
    expect(verifyLineSignature(RAW_BODY, SECRET, digest.toString('base64'))).toBe(false);
  });

  it('長さの違う署名 → false（timingSafeEqual で throw しない）', () => {
    const short = Buffer.alloc(8, 1).toString('base64');
    expect(() => verifyLineSignature(RAW_BODY, SECRET, short)).not.toThrow();
    expect(verifyLineSignature(RAW_BODY, SECRET, short)).toBe(false);
  });

  it('署名ヘッダ無し (undefined) → false', () => {
    expect(verifyLineSignature(RAW_BODY, SECRET, undefined)).toBe(false);
  });

  it('別の channelSecret で作った署名 → false', () => {
    expect(verifyLineSignature(RAW_BODY, SECRET, goodSignature(RAW_BODY, 'other-secret'))).toBe(false);
  });
});
