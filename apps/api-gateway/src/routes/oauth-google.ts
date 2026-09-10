// Google OAuth（セルフサーブ接続）。prefix /api/oauth/google。
//
// フロー:
//   POST /start (requireOwner) → { authUrl } を返す（ブラウザの top-level リダイレクトには
//   Authorization ヘッダが乗らないため、フロントが XHR で URL を取得して遷移する）
//   → Google 同意画面 → GET /callback?code&state（無認証。state の JWT 署名検証が
//   orgId バインディングの唯一の根拠）→ code 交換 → 暗号化保存 → フロントへ 302。
//
// スコープは openid email drive.file のみ。drive.file は「このアプリが作成したファイル」
// 限定の非センシティブスコープで、GCP アプリを本番公開しても Google 審査が不要。
// ⚠️ client_secret はサーバー内のみ。トークンをログ・レスポンスに出さない。

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { prisma } from '../utils/prisma';
import { requireOwner } from '../middleware/auth';
import { sealSecret } from '../services/secret-box';
import { syncRequiredCredentialStatus } from '../services/integration-sync';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const API_TIMEOUT_MS = 10_000;

type AuthPayload = { orgId: string; sub?: string };
type StatePayload = { purpose: string; orgId: string; nonce: string };

function gatewayBase(): string {
  return (process.env.API_GATEWAY_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

/** リダイレクト先は FRONTEND_URL の先頭固定（returnTo は受け取らない = オープンリダイレクト封じ）。 */
function frontendBase(): string {
  return (
    (process.env.FRONTEND_URL ?? 'http://localhost:3000').split(',')[0]?.trim() ??
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

/** id_token (JWT) の payload だけを読む。TLS 直取得なので署名検証は省略してよい。 */
function decodeIdTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

export async function oauthGoogleRoutes(app: FastifyInstance): Promise<void> {
  // ── 認可 URL の発行 ──────────────────────────────────
  app.post('/start', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      return reply.code(503).send({
        success: false,
        error: {
          code: 'NOT_CONFIGURED',
          message: 'Google 連携が未設定です（GOOGLE_OAUTH_CLIENT_ID / SECRET を環境変数に設定してください）。',
        },
      });
    }
    const state = app.jwt.sign(
      { purpose: 'google_oauth', orgId: payload.orgId, nonce: randomUUID() },
      { expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${gatewayBase()}/api/oauth/google/callback`,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent', // refresh_token を確実に得る
      state,
    });
    return reply.send({ success: true, data: { authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}` } });
  });

  // ── コールバック（無認証・state 署名検証） ──────────
  app.get('/callback', async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    const settingsUrl = `${frontendBase()}/settings?tab=integrations`;

    if (q.error) {
      // ユーザーが同意画面で拒否した等
      return reply.redirect(`${settingsUrl}&error=google_denied`);
    }
    if (!q.code || !q.state) {
      return reply.redirect(`${settingsUrl}&error=google_state`);
    }

    let state: StatePayload;
    try {
      state = app.jwt.verify<StatePayload>(q.state);
      if (state.purpose !== 'google_oauth' || !state.orgId) throw new Error('bad purpose');
    } catch {
      return reply.redirect(`${settingsUrl}&error=google_state`);
    }

    // code 交換（client_secret はここでのみ使用）
    interface GoogleTokenResponse {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      id_token?: unknown;
    }
    let token: GoogleTokenResponse | null = null;
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
          client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
          redirect_uri: `${gatewayBase()}/api/oauth/google/callback`,
        }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (res.ok) token = (await res.json()) as GoogleTokenResponse;
    } catch {
      token = null;
    }
    if (!token || typeof token.access_token !== 'string') {
      return reply.redirect(`${settingsUrl}&error=google_exchange`);
    }

    const email = decodeIdTokenEmail(typeof token.id_token === 'string' ? token.id_token : undefined);
    const expiresAt = new Date(
      Date.now() + (typeof token.expires_in === 'number' ? token.expires_in : 3600) * 1000,
    );

    const existing = await prisma.providerConnection.findUnique({
      where: { orgId_provider: { orgId: state.orgId, provider: 'google' } },
    });
    // refresh_token は初回同意時のみ返ることがある。返らなかったら既存を温存する。
    const refreshTokenEnc =
      typeof token.refresh_token === 'string'
        ? sealSecret(token.refresh_token)
        : existing?.refreshTokenEnc ?? null;

    await prisma.providerConnection.upsert({
      where: { orgId_provider: { orgId: state.orgId, provider: 'google' } },
      create: {
        orgId: state.orgId,
        provider: 'google',
        accessTokenEnc: sealSecret(token.access_token),
        refreshTokenEnc,
        tokenExpiresAt: expiresAt,
        scopes: SCOPES,
        externalAccountId: email,
        displayName: email,
        status: 'CONNECTED',
        lastCheckedAt: new Date(),
      },
      update: {
        accessTokenEnc: sealSecret(token.access_token),
        refreshTokenEnc,
        tokenExpiresAt: expiresAt,
        scopes: SCOPES,
        externalAccountId: email ?? existing?.externalAccountId ?? null,
        displayName: email ?? existing?.displayName ?? null,
        status: 'CONNECTED',
        lastCheckedAt: new Date(),
      },
    });
    await syncRequiredCredentialStatus(state.orgId, 'google', 'CONNECTED');

    return reply.redirect(`${settingsUrl}&connected=google`);
  });
}
