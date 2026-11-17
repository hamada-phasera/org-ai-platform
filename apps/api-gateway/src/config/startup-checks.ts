// 起動してはいけない設定を、listen の前に止める（index.ts の start から呼ぶ）。
//
// ■ 止めるもの
//   - JWT_SECRET が無い・32 文字未満（どの環境でも）
//   - 本番で JWT_SECRET がリポジトリに載っている値（.env.example の見本、docker-compose の開発用既定値）
//   - 本番（NODE_ENV=production）で N8N_WEBHOOK_AUTH_TOKEN が未設定・空・公開されている既定値
//     （既定値はリポジトリに載っているので、誰でも n8n コールバックを偽装できる）
// ■ 止めないもの（表示だけ。設定 > 基本 の「セットアップ状況」）
//   - INTERNAL_API_TOKEN 未設定（既存の本番を止めうるため。計画書チャンク 7「やらないこと」）
//   - GEMINI_PAID_TIER=false
// ⚠️ メッセージに値そのものを入れない（ログに秘密が出る）。変数名と直し方だけ。

import { config } from './env';

export class StartupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupConfigError';
  }
}

/**
 * リポジトリに書いてある（＝誰でも知っている）JWT_SECRET。本番でこれだと誰でもトークンを作れる。
 * ⚠️ `.env.example` と `docker-compose.yml` の値を変えたらここも直す（scripts/check-deploy-config.mjs が突き合わせる）。
 */
export const PUBLIC_JWT_SECRETS: readonly string[] = [
  'change_me_minimum_32_characters_required_xxxxxxxx',
  'compose-dev-only-jwt-secret-not-for-production-0000',
];

/** 起動してよい設定かを確かめる。だめなら StartupConfigError を投げる。 */
export function assertStartupConfig(): void {
  const jwtSecret = config.jwtSecret;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new StartupConfigError('JWT_SECRET is required and must be at least 32 characters. Set it in your environment.');
  }
  if (config.isProduction && PUBLIC_JWT_SECRETS.includes(jwtSecret)) {
    throw new StartupConfigError(
      'JWT_SECRET uses a value published in the repository (.env.example or docker-compose.yml). ' +
        'Set a unique value (e.g. `openssl rand -hex 32`) before starting in production.',
    );
  }
  if (config.isProduction && (config.n8nWebhookAuthTokenIsDefault || !config.n8nWebhookAuthToken.trim())) {
    throw new StartupConfigError(
      'N8N_WEBHOOK_AUTH_TOKEN is unset or uses the public default value. ' +
        'Set a unique value (e.g. `openssl rand -hex 32`) on api-gateway and n8n before starting in production.',
    );
  }
}
