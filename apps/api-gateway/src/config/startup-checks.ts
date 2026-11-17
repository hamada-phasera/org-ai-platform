// 起動してはいけない設定を、listen の前に止める（index.ts の start から呼ぶ）。
//
// ■ 止めるもの
//   - JWT_SECRET が無い・32 文字未満（どの環境でも）
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

/** 起動してよい設定かを確かめる。だめなら StartupConfigError を投げる。 */
export function assertStartupConfig(): void {
  const jwtSecret = config.jwtSecret;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new StartupConfigError('JWT_SECRET is required and must be at least 32 characters. Set it in your environment.');
  }
  if (config.isProduction && (config.n8nWebhookAuthTokenIsDefault || !config.n8nWebhookAuthToken.trim())) {
    throw new StartupConfigError(
      'N8N_WEBHOOK_AUTH_TOKEN is unset or uses the public default value. ' +
        'Set a unique value (e.g. `openssl rand -hex 32`) on api-gateway and n8n before starting in production.',
    );
  }
}
