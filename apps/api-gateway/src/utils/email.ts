// メールアドレスの正規化。登録・ログイン・招待は必ずここを通す（大文字小文字・前後の空白で別人にしない）。
// ⚠️ ローカル部（@ の前）も小文字にする。RFC 上は区別できるが、実際のメール事業者は区別しないので、
//    区別すると「A@x.jp で登録した人が a@x.jp でログインできない」事故のほうが大きい。

import { z } from 'zod';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 入力の検証と正規化をまとめた zod スキーマ（trim → 小文字 → 形式チェック）。 */
export const emailSchema = z.string().trim().toLowerCase().email();
