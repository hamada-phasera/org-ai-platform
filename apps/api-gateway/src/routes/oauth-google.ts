// Google OAuth（セルフサーブ連携）。prefix /api/oauth/google。
//
// フロー（3 段階。CSRF とトークン悪用を構造的に潰すためこの形にしている）:
//   1. POST /start (requireOwner) → { authUrl } を返す
//      ブラウザの top-level リダイレクトには Authorization ヘッダが乗らないため、
//      フロントが XHR で URL を取得してから遷移する。
//   2. GET /callback?code&state（無認証）→ code を交換し、トークンは **どの org にも紐づけず**
//      サーバー内の一時保管に置いて、フロントへ ?googleLink=<linkId> で戻す。
//   3. POST /confirm { linkId } (requireOwner) → **ログイン中のセッションの orgId** に保存する。
//
// なぜ callback で保存しないか（アカウント連結 CSRF 対策）:
//   state に orgId を埋めて callback で保存する実装だと、攻撃者が自分の org の state を作って
//   被害者にリンクを踏ませるだけで「被害者の Google が攻撃者の org に繋がる」。
//   保存先を「confirm を叩いた本人のセッション」に変えると、被害者が踏んでも
//   繋がるのは被害者自身の org なので実害が消える。
//
// なぜ state を app.jwt で署名しないか:
//   app.jwt の鍵はログイン JWT と同じで、requireAuth は「その鍵で検証が通る JWT」を
//   すべて受け入れる。state は URL・ブラウザ履歴・Google 側ログに残る値なので、
//   それが API のベアラトークンとして通るのは権限昇格になる。用途専用の HMAC で署名する。
//
// スコープは openid email drive.file のみ。drive.file は「このアプリが作成したファイル」
// 限定の非センシティブスコープで、GCP アプリを本番公開しても Google 審査が不要。
// ⚠️ client_secret はサーバー内のみ。トークンをログ・レスポンスに出さない。

import type { FastifyInstance } from 'fastify';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { requireOwner } from '../middleware/auth';
import { sealSecret } from '../services/secret-box';
import { syncRequiredCredentialStatus } from '../services/integration-sync';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const API_TIMEOUT_MS = 10_000;
const STATE_TTL_MS = 10 * 60_000;
const PENDING_LINK_TTL_MS = 10 * 60_000;

type AuthPayload = { orgId: string; sub?: string };

const confirmSchema = z.object({ linkId: z.string().min(1).max(100) });

/** state 署名用の鍵。ログイン JWT とは必ず別の鍵にする（用途分離）。 */
function stateKey(): Buffer {
  const explicit = process.env.OAUTH_STATE_SECRET;
  if (explicit) return createHash('sha256').update(explicit).digest();
  // 独立設定が無い場合も、JWT_SECRET そのものではなく用途ラベル付きで派生させる
  return createHash('sha256').update(`oauth-state:${process.env.JWT_SECRET ?? ''}`).digest();
}

function signState(payload: { nonce: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', stateKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(raw: string): boolean {
  const parts = raw.split('.');
  if (parts.length !== 2) return false;
  const [body, sig] = parts;
  const expected = createHmac('sha256', stateKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

/** 交換済みトークンの一時保管（confirm されるまで、どの org にも属さない）。
 *  プロセス内メモリなので gateway 再起動で消えるが、その場合はユーザーが接続し直せばよい。 */
interface PendingLink {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  email: string | null;
  createdAt: number;
}
const pendingLinks = new Map<string, PendingLink>();

function prunePendingLinks(): void {
  const now = Date.now();
  for (const [id, link] of pendingLinks) {
    if (now - link.createdAt > PENDING_LINK_TTL_MS) pendingLinks.delete(id);
  }
}

function gatewayBase(): string {
  return (process.env.API_GATEWAY_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

/** リダイレクト先は自分のフロント固定（returnTo は受け取らない = オープンリダイレクト封じ）。
 *
 *  優先順:
 *   1. FRONTEND_URL の先頭にある妥当な http(s) URL
 *   2. ALLOWED_ORIGIN_HOSTS の先頭ホスト（= CORS で許可している本番フロント）
 *   3. localhost（開発）
 *
 *  2 を挟んでいるのは実測の反省: 本番の FRONTEND_URL は CORS 用に '*' が入っていて
 *  候補が 1 つも取れず、Google 接続後に localhost へ飛ばされる状態だった。
 *  CORS で許可しているホストは「自分のフロント」と判っているので、そこへ戻すのが安全。 */
function frontendBase(): string {
  const fallback = 'http://localhost:3000';
  const candidates = (process.env.FRONTEND_URL ?? '').split(',').map((s) => s.trim());
  for (const c of candidates) {
    if (!c || c === '*') continue;
    try {
      const u = new URL(c);
      if (u.protocol === 'http:' || u.protocol === 'https:') return c.replace(/\/$/, '');
    } catch {
      // 次の候補へ
    }
  }
  const allowedHost = (process.env.ALLOWED_ORIGIN_HOSTS ?? 'org-ai-platform.vercel.app')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (allowedHost) return `https://${allowedHost}`;
  return fallback;
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
  app.post('/start', { preHandler: requireOwner }, async (_request, reply) => {
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
    // state に orgId は入れない（保存先は confirm 時のセッションで決まるため不要）
    const state = signState({ nonce: randomUUID(), exp: Date.now() + STATE_TTL_MS });
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

  // ── コールバック（無認証・state 署名検証のみ。保存はしない） ──
  // logLevel: 'silent' — URL に code と state が載るため、アクセスログに残さない
  app.get('/callback', { logLevel: 'silent' }, async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    const settingsUrl = `${frontendBase()}/settings?tab=integrations`;

    if (q.error) {
      // ユーザーが同意画面で拒否した等
      return reply.redirect(`${settingsUrl}&error=google_denied`);
    }
    if (!q.code || !q.state || !verifyState(q.state)) {
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

    prunePendingLinks();
    const linkId = randomUUID();
    pendingLinks.set(linkId, {
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : null,
      expiresAt: new Date(
        Date.now() + (typeof token.expires_in === 'number' ? token.expires_in : 3600) * 1000,
      ),
      email: decodeIdTokenEmail(typeof token.id_token === 'string' ? token.id_token : undefined),
      createdAt: Date.now(),
    });

    // まだ誰の org にも保存していない。ログイン中のユーザーが confirm して初めて紐づく。
    return reply.redirect(`${settingsUrl}&googleLink=${linkId}`);
  });

  // ── 確定（ログイン中のセッションの org に保存する） ──
  app.post('/confirm', { preHandler: requireOwner }, async (request, reply) => {
    const payload = request.user as AuthPayload;
    const parsed = confirmSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    prunePendingLinks();
    const link = pendingLinks.get(parsed.data.linkId);
    if (!link) {
      return reply.code(410).send({
        success: false,
        error: {
          code: 'LINK_EXPIRED',
          message: '接続の確認期限が切れました。もう一度「Google で接続」からやり直してください。',
        },
      });
    }
    // ワンタイム消費（同じ linkId で二重に紐づけられないように）
    pendingLinks.delete(parsed.data.linkId);

    const existing = await prisma.providerConnection.findUnique({
      where: { orgId_provider: { orgId: payload.orgId, provider: 'google' } },
    });
    // refresh_token は初回同意時のみ返ることがある。返らなかったら既存を温存する。
    const refreshTokenEnc = link.refreshToken
      ? sealSecret(link.refreshToken)
      : (existing?.refreshTokenEnc ?? null);

    await prisma.providerConnection.upsert({
      where: { orgId_provider: { orgId: payload.orgId, provider: 'google' } },
      create: {
        orgId: payload.orgId,
        provider: 'google',
        accessTokenEnc: sealSecret(link.accessToken),
        refreshTokenEnc,
        tokenExpiresAt: link.expiresAt,
        scopes: SCOPES,
        externalAccountId: link.email,
        displayName: link.email,
        status: 'CONNECTED',
        lastCheckedAt: new Date(),
      },
      update: {
        accessTokenEnc: sealSecret(link.accessToken),
        refreshTokenEnc,
        tokenExpiresAt: link.expiresAt,
        scopes: SCOPES,
        externalAccountId: link.email ?? existing?.externalAccountId ?? null,
        displayName: link.email ?? existing?.displayName ?? null,
        status: 'CONNECTED',
        lastCheckedAt: new Date(),
      },
    });
    await syncRequiredCredentialStatus(payload.orgId, 'google', 'CONNECTED');

    return reply.send({ success: true, data: { provider: 'google', displayName: link.email } });
  });
}
