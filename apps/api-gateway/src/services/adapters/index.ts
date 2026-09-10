// native adapter レジストリ。capability 名 → gateway 直接実行の実装。
// 登録されている capability は n8n を通らず、セルフサーブ接続（ProviderConnection）の
// トークンで gateway が直接 Slack / Google API を叩く。
// 戻り値は既存の N8nEnvelope に統一し、resolver の ExecutionLog 記録が無変更で効く。

import type { N8nEnvelope } from '../capability-executor';
import { prisma } from '../../utils/prisma';
import { openSecret } from '../secret-box';
import { getGoogleAccessToken } from '../google-auth';
import { syncRequiredCredentialStatus } from '../integration-sync';
import { postMessage } from './slack-client';
import { createDoc, createSheet, createSlides, type SlideInput, type GoogleApiResult } from './google-client';

export type AdapterContext = { orgId: string };
export type CapabilityAdapter = (
  args: Record<string, unknown>,
  ctx: AdapterContext,
) => Promise<N8nEnvelope>;

const AUTH_MISSING_SLACK: N8nEnvelope = {
  status: 'error',
  error_type: 'AUTH_MISSING',
  message: 'Slack が接続されていません。設定 > 連携 から接続してください。',
  data: null,
};

const AUTH_MISSING_GOOGLE: N8nEnvelope = {
  status: 'error',
  error_type: 'AUTH_MISSING',
  message: 'Google の接続または再接続が必要です。設定 > 連携 から接続してください。',
  data: null,
};

/** org の Slack Bot トークンを復号して返す。未接続 / 復号不能は null。 */
async function getSlackToken(orgId: string): Promise<string | null> {
  const conn = await prisma.providerConnection.findUnique({
    where: { orgId_provider: { orgId, provider: 'slack' } },
  });
  if (!conn || conn.status !== 'CONNECTED') return null;
  try {
    return openSecret(conn.accessTokenEnc);
  } catch {
    return null;
  }
}

/** Slack のトークン死亡を検知したら再接続要求に落とす。 */
async function markSlackDead(orgId: string): Promise<void> {
  await prisma.providerConnection.updateMany({
    where: { orgId, provider: 'slack' },
    data: { status: 'NEEDS_RECONNECT', lastCheckedAt: new Date() },
  });
  await syncRequiredCredentialStatus(orgId, 'slack', 'DISCONNECTED');
}

const notifySlackAdapter: CapabilityAdapter = async (args, ctx) => {
  const token = await getSlackToken(ctx.orgId);
  if (!token) return AUTH_MISSING_SLACK;
  const channel = String(args.channel ?? '');
  const text = String(args.text ?? '');
  const result = await postMessage(token, channel, text);
  if (result.ok) {
    return {
      status: 'success',
      error_type: null,
      message: 'Slack に投稿しました',
      data: { channel: result.channel, ts: result.ts },
    };
  }
  if (result.authDead) {
    await markSlackDead(ctx.orgId);
    return AUTH_MISSING_SLACK;
  }
  const hint =
    result.error === 'channel_not_found' || result.error === 'not_in_channel'
      ? 'チャンネル名を確認するか、非公開チャンネルの場合は /invite でボットを招待してください。'
      : '';
  return {
    status: 'error',
    error_type: result.error === 'timeout' ? 'TIMEOUT' : 'NODE_FAILED',
    message: `Slack 投稿に失敗しました (${result.error})。${hint}`,
    data: null,
  };
};

/** Google 系 adapter の共通後処理: 401 なら再接続要求に落として AUTH_MISSING。 */
async function googleEnvelope<T extends object>(
  ctx: AdapterContext,
  result: GoogleApiResult<T>,
  successMessage: string,
): Promise<N8nEnvelope> {
  if (result.ok) {
    return { status: 'success', error_type: null, message: successMessage, data: result.data };
  }
  if (result.authDead) {
    // getGoogleAccessToken 側でも落とすが、実行時 401（スコープ剥奪等）はここで検知される
    await prisma.providerConnection.updateMany({
      where: { orgId: ctx.orgId, provider: 'google' },
      data: { status: 'NEEDS_RECONNECT', lastCheckedAt: new Date() },
    });
    await syncRequiredCredentialStatus(ctx.orgId, 'google', 'DISCONNECTED');
    return AUTH_MISSING_GOOGLE;
  }
  return {
    status: 'error',
    error_type: result.message === 'timeout' ? 'TIMEOUT' : 'NODE_FAILED',
    message: result.message,
    data: null,
  };
}

const createGoogleDocAdapter: CapabilityAdapter = async (args, ctx) => {
  const token = await getGoogleAccessToken(ctx.orgId);
  if (!token.ok) return AUTH_MISSING_GOOGLE;
  const result = await createDoc(token.accessToken, String(args.title ?? ''), String(args.content ?? ''));
  return googleEnvelope(ctx, result, 'Google ドキュメントを作成しました');
};

const createGoogleSheetAdapter: CapabilityAdapter = async (args, ctx) => {
  const token = await getGoogleAccessToken(ctx.orgId);
  if (!token.ok) return AUTH_MISSING_GOOGLE;
  const headers = Array.isArray(args.headers) ? (args.headers as unknown[]).map(String) : [];
  const rows = Array.isArray(args.rows)
    ? (args.rows as unknown[]).map((r) => (Array.isArray(r) ? (r as unknown[]).map(String) : [String(r)]))
    : [];
  const result = await createSheet(token.accessToken, String(args.title ?? ''), headers, rows);
  return googleEnvelope(ctx, result, 'Google スプレッドシートを作成しました');
};

const createGoogleSlidesAdapter: CapabilityAdapter = async (args, ctx) => {
  const token = await getGoogleAccessToken(ctx.orgId);
  if (!token.ok) return AUTH_MISSING_GOOGLE;
  const slides: SlideInput[] = Array.isArray(args.slides)
    ? (args.slides as unknown[]).map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        return {
          title: typeof o.title === 'string' ? o.title : undefined,
          content: typeof o.content === 'string' ? o.content : undefined,
        };
      })
    : [];
  const result = await createSlides(token.accessToken, String(args.title ?? ''), slides);
  return googleEnvelope(ctx, result, 'Google スライドを作成しました');
};

const ADAPTERS: Record<string, CapabilityAdapter> = {
  notify_slack: notifySlackAdapter,
  create_google_doc: createGoogleDocAdapter,
  create_google_sheet: createGoogleSheetAdapter,
  create_google_slides: createGoogleSlidesAdapter,
};

export function getNativeAdapter(capabilityName: string): CapabilityAdapter | null {
  return ADAPTERS[capabilityName] ?? null;
}
