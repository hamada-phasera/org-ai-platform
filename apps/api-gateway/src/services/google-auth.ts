// Google OAuth のトークン管理。取得済みトークンの復号・期限判定・自動リフレッシュを担う。
// ⚠️ ログ・エラーメッセージにトークン（平文・暗号文とも）を絶対に含めないこと。
//
// スコープは openid email drive.file の 3 つのみ（routes/oauth-google.ts 参照）。
// drive.file は「このアプリが作成したファイル」に限定される非センシティブスコープで、
// Docs/Sheets/Slides の create + その後の batchUpdate をすべてカバーする。

import { prisma } from '../utils/prisma';
import { sealSecret, openSecret } from './secret-box';
import { syncRequiredCredentialStatus } from './integration-sync';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_TIMEOUT_MS = 10_000;
/** 期限ぎりぎりのトークンを掴まないためのスキュー。 */
const EXPIRY_SKEW_MS = 60_000;

export function isTokenExpired(expiresAt: Date | null, now: Date, skewMs: number = EXPIRY_SKEW_MS): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - skewMs <= now.getTime();
}

export type GoogleTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'NOT_CONNECTED' | 'NEEDS_RECONNECT' };

/**
 * org の Google access_token を返す。期限切れなら refresh_token で更新して保存する。
 * refresh が invalid_grant（ユーザーが取り消した / テストモードの7日失効）なら
 * status を NEEDS_RECONNECT に落とし、RequiredCredential も DISCONNECTED に同期する。
 *
 * 並行呼び出しで二重リフレッシュしても Google は旧 access_token を期限まで有効に保つため
 * 楽観的に last-write-wins とする（ロックは持たない）。
 */
export async function getGoogleAccessToken(orgId: string): Promise<GoogleTokenResult> {
  const conn = await prisma.providerConnection.findUnique({
    where: { orgId_provider: { orgId, provider: 'google' } },
  });
  if (!conn || conn.status === 'DISABLED') return { ok: false, reason: 'NOT_CONNECTED' };
  if (conn.status === 'NEEDS_RECONNECT') return { ok: false, reason: 'NEEDS_RECONNECT' };

  if (!isTokenExpired(conn.tokenExpiresAt, new Date())) {
    try {
      return { ok: true, accessToken: openSecret(conn.accessTokenEnc) };
    } catch {
      // 復号失敗（鍵ローテ等）は再接続でしか直らない
      await markNeedsReconnect(conn.id, orgId);
      return { ok: false, reason: 'NEEDS_RECONNECT' };
    }
  }

  if (!conn.refreshTokenEnc) {
    await markNeedsReconnect(conn.id, orgId);
    return { ok: false, reason: 'NEEDS_RECONNECT' };
  }

  let refreshToken: string;
  try {
    refreshToken = openSecret(conn.refreshTokenEnc);
  } catch {
    await markNeedsReconnect(conn.id, orgId);
    return { ok: false, reason: 'NEEDS_RECONNECT' };
  }

  const refreshed = await requestRefresh(refreshToken);
  if (!refreshed.ok) {
    if (refreshed.invalidGrant) {
      await markNeedsReconnect(conn.id, orgId);
      return { ok: false, reason: 'NEEDS_RECONNECT' };
    }
    // ネットワーク等の一時故障: 状態は変えず、今回だけ失敗扱い（次回リトライで直る）
    return { ok: false, reason: 'NEEDS_RECONNECT' };
  }

  await prisma.providerConnection.update({
    where: { id: conn.id },
    data: {
      accessTokenEnc: sealSecret(refreshed.accessToken),
      tokenExpiresAt: new Date(Date.now() + refreshed.expiresInSec * 1000),
      lastCheckedAt: new Date(),
    },
  });
  return { ok: true, accessToken: refreshed.accessToken };
}

async function markNeedsReconnect(connectionId: string, orgId: string): Promise<void> {
  await prisma.providerConnection.update({
    where: { id: connectionId },
    data: { status: 'NEEDS_RECONNECT', lastCheckedAt: new Date() },
  });
  await syncRequiredCredentialStatus(orgId, 'google', 'DISCONNECTED');
}

type RefreshResult =
  | { ok: true; accessToken: string; expiresInSec: number }
  | { ok: false; invalidGrant: boolean };

async function requestRefresh(refreshToken: string): Promise<RefreshResult> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) return { ok: false, invalidGrant: false };
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
    } | null;
    if (res.ok && typeof json?.access_token === 'string') {
      return {
        ok: true,
        accessToken: json.access_token,
        expiresInSec: typeof json.expires_in === 'number' ? json.expires_in : 3600,
      };
    }
    return { ok: false, invalidGrant: json?.error === 'invalid_grant' };
  } catch {
    return { ok: false, invalidGrant: false };
  }
}

/** 接続解除時の best-effort revoke（失敗しても解除自体は続行してよい）。 */
export async function revokeGoogleToken(tokenEnc: string): Promise<void> {
  try {
    const token = openSecret(tokenEnc);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    // best-effort
  }
}
