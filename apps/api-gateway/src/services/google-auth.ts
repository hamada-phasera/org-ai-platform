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

/**
 * TEMPORARY_FAILURE は「接続は生きているが今回は取れなかった」＝時間をおけば直る失敗。
 * NEEDS_RECONNECT（本当に失効・再接続が要る）と混ぜると、ネットワーク瞬断や Google 側 5xx でも
 * UI が「再接続が必要」と促してしまうため、呼び出し側が区別できるよう分けている。
 */
export type GoogleTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'NOT_CONNECTED' | 'NEEDS_RECONNECT' | 'TEMPORARY_FAILURE' };

/**
 * org の Google access_token を返す。期限切れなら refresh_token で更新して保存する。
 * refresh が invalid_grant（ユーザーが取り消した / テストモードの7日失効）なら
 * status を NEEDS_RECONNECT に落とし、RequiredCredential も DISCONNECTED に同期する。
 * ネットワーク瞬断や Google 側 5xx/429 は TEMPORARY_FAILURE を返し、ProviderConnection は触らない。
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
    if (refreshed.failure === 'invalid_grant') {
      await markNeedsReconnect(conn.id, orgId);
      return { ok: false, reason: 'NEEDS_RECONNECT' };
    }
    if (refreshed.failure === 'temporary') {
      // ネットワーク瞬断 / Google 側 5xx・429: 接続自体は生きているので状態は変えず、
      // 「再接続が必要」とも言わない。次回リトライで直る想定。
      console.warn(`[google-auth] トークンのリフレッシュが一時的に失敗 (org=${orgId})`);
      return { ok: false, reason: 'TEMPORARY_FAILURE' };
    }
    // invalid_client / unauthorized_client / OAuth クライアント未設定など、
    // リトライしても直らない失敗。状態は変えないが再接続を促す（従来どおり）。
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

/** invalid_grant=本当に失効 / temporary=瞬断・5xx・429 / permanent=設定不備など再試行しても無駄。 */
type RefreshFailure = 'invalid_grant' | 'temporary' | 'permanent';

type RefreshResult =
  | { ok: true; accessToken: string; expiresInSec: number }
  | { ok: false; failure: RefreshFailure };

async function requestRefresh(refreshToken: string): Promise<RefreshResult> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) return { ok: false, failure: 'permanent' };
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
    if (json?.error === 'invalid_grant') return { ok: false, failure: 'invalid_grant' };
    // Google 側の一時故障（5xx）とレート制限（429）はリトライで直るので接続を殺さない。
    const status = typeof res.status === 'number' ? res.status : 0;
    if (status >= 500 || status === 429) return { ok: false, failure: 'temporary' };
    return { ok: false, failure: 'permanent' };
  } catch {
    // fetch の throw = ネットワーク断 / AbortSignal.timeout によるタイムアウト。
    return { ok: false, failure: 'temporary' };
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
