// チャネル資格情報（LINE channel secret / access token 等）の対称暗号ユーティリティ。
// AES-256-GCM で封緘し、`v1:${iv}:${authTag}:${cipher}`（各 base64）の文字列として DB に保存する。
// 平文の secret / token は DB にもログにも絶対に出さないこと。
//
// 鍵は CHANNEL_CREDENTIAL_ENC_KEY（32 バイトを 64 桁 hex または base64 で指定）。
// 未設定時は JWT_SECRET から sha256 で導出するフォールバックを使う。
// ⚠️ フォールバック鍵は JWT_SECRET をローテーションすると既存の暗号文が復号不能になる。
//    本番では CHANNEL_CREDENTIAL_ENC_KEY を独立に設定すること（render.yaml 参照）。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const SEAL_VERSION = 'v1';
const IV_BYTES = 12; // GCM 推奨の 96bit nonce

function getKey(): Buffer {
  const raw = process.env.CHANNEL_CREDENTIAL_ENC_KEY;
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) {
      return b64;
    }
    throw new Error(
      'CHANNEL_CREDENTIAL_ENC_KEY must be 32 bytes, given as 64-char hex or base64.',
    );
  }
  // フォールバック: JWT_SECRET から導出（JWT_SECRET ローテで既存暗号文は復号不能になる）
  return createHash('sha256').update(`${process.env.JWT_SECRET}:channel-secret-box`).digest();
}

/** 平文を暗号化して DB 保存用の文字列にする。 */
export function sealSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEAL_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** sealSecret の出力を復号する。改竄・鍵不一致・形式不正は throw。 */
export function openSecret(sealed: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) {
    throw new Error('openSecret: invalid sealed format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  // authTag 検証に失敗（改竄）した場合は decipher.final() が throw する
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
