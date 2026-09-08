import { describe, it, expect, beforeEach } from 'vitest';
import { sealSecret, openSecret } from '../secret-box';

// 32 バイト鍵の 2 表現（getKey は hex を先に判定する）
const HEX_KEY = Buffer.alloc(32, 7).toString('hex'); // 64 桁 hex
const B64_KEY = Buffer.alloc(32, 9).toString('base64');

beforeEach(() => {
  delete process.env.CHANNEL_CREDENTIAL_ENC_KEY;
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars';
});

describe('secret-box', () => {
  it('hex 鍵で seal → open のラウンドトリップが成立する', () => {
    process.env.CHANNEL_CREDENTIAL_ENC_KEY = HEX_KEY;
    const sealed = sealSecret('line-channel-secret-123');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('line-channel-secret-123'); // 平文が漏れていない
    expect(openSecret(sealed)).toBe('line-channel-secret-123');
  });

  it('base64 鍵でもラウンドトリップが成立する', () => {
    process.env.CHANNEL_CREDENTIAL_ENC_KEY = B64_KEY;
    const sealed = sealSecret('トークン♥ multi-byte');
    expect(openSecret(sealed)).toBe('トークン♥ multi-byte');
  });

  it('暗号文の改竄は throw する (GCM authTag)', () => {
    process.env.CHANNEL_CREDENTIAL_ENC_KEY = HEX_KEY;
    const sealed = sealSecret('secret-value-to-tamper');
    const parts = sealed.split(':');
    // cipher 部の先頭 1 文字を別の文字に差し替える
    const cipher = parts[3];
    parts[3] = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1);
    expect(() => openSecret(parts.join(':'))).toThrow();
  });

  it('形式不正の文字列は throw する', () => {
    process.env.CHANNEL_CREDENTIAL_ENC_KEY = HEX_KEY;
    expect(() => openSecret('not-a-sealed-secret')).toThrow();
    expect(() => openSecret('v2:a:b:c')).toThrow();
  });

  it('32 バイトに解釈できない鍵は throw する', () => {
    process.env.CHANNEL_CREDENTIAL_ENC_KEY = 'too-short';
    expect(() => sealSecret('x')).toThrow(/CHANNEL_CREDENTIAL_ENC_KEY/);
  });

  it('鍵未設定時は JWT_SECRET 由来のフォールバック鍵でラウンドトリップできる', () => {
    // beforeEach で CHANNEL_CREDENTIAL_ENC_KEY は未設定
    const sealed = sealSecret('fallback-mode-secret');
    expect(openSecret(sealed)).toBe('fallback-mode-secret');
  });

  it('フォールバック鍵は JWT_SECRET ローテで復号不能になる', () => {
    const sealed = sealSecret('sealed-under-old-jwt-secret');
    process.env.JWT_SECRET = 'rotated-jwt-secret-also-32-chars-long!!';
    expect(() => openSecret(sealed)).toThrow();
  });
});
