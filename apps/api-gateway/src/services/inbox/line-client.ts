// LINE Messaging API の薄いクライアント（SDK 不使用）。
// n8n-workflow-builder.ts の n8nFetch と同じ流儀: fetch + AbortSignal.timeout、
// 失敗しても throw で上流を巻き込まず、呼び出し側がフォールバックできる戻り値にする。
// ⚠️ ログに accessToken / channelSecret を絶対に出さないこと。

import { createHmac, timingSafeEqual } from 'crypto';
import type { LineEventSource } from './line-types';

const LINE_API_BASE = 'https://api.line.me';
const API_TIMEOUT_MS = 10_000;

function lineFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
  return fetch(`${LINE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

/**
 * webhook 署名検証。x-line-signature は raw body の HMAC-SHA256 (base64)。
 * 長さチェック → timingSafeEqual の順（長さ不一致で throw させない）。signature 無しは false。
 */
export function verifyLineSignature(
  rawBody: Buffer,
  channelSecret: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

export type PushResult = { ok: true } | { ok: false; status: number; body: string };

/**
 * テキストメッセージを push 送信する。retryKey (UUID) を渡すと X-Line-Retry-Key で
 * LINE 側が二重送信を防ぐ（同一キーの再送は 409 相当で握られる）。
 */
export async function pushTextMessage(
  accessToken: string,
  to: string,
  text: string,
  retryKey?: string,
): Promise<PushResult> {
  try {
    const res = await lineFetch('/v2/bot/message/push', accessToken, {
      method: 'POST',
      headers: retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 500) };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

/** 送信者の表示名を取得する（失敗は null。下書き生成を止めない）。 */
export async function getSenderProfile(
  accessToken: string,
  source: LineEventSource,
): Promise<string | null> {
  const uid = source.userId;
  if (!uid) return null;
  let path: string;
  if (source.type === 'group' && source.groupId) {
    path = `/v2/bot/group/${source.groupId}/member/${uid}`;
  } else if (source.type === 'room' && source.roomId) {
    path = `/v2/bot/room/${source.roomId}/member/${uid}`;
  } else if (source.type === 'user') {
    path = `/v2/bot/profile/${uid}`;
  } else {
    return null;
  }
  try {
    const res = await lineFetch(path, accessToken);
    if (!res.ok) return null;
    const json = (await res.json()) as { displayName?: unknown };
    return typeof json.displayName === 'string' ? json.displayName : null;
  } catch {
    return null;
  }
}

export interface LineBotInfo {
  userId: string;
  displayName: string;
  basicId: string;
}

/** ボット情報の取得。接続登録時の資格情報検証 + channelId(destination) の取得に使う。失敗は null。 */
export async function getBotInfo(accessToken: string): Promise<LineBotInfo | null> {
  try {
    const res = await lineFetch('/v2/bot/info', accessToken);
    if (!res.ok) return null;
    const json = (await res.json()) as { userId?: unknown; displayName?: unknown; basicId?: unknown };
    if (typeof json.userId !== 'string') return null;
    return {
      userId: json.userId,
      displayName: typeof json.displayName === 'string' ? json.displayName : '',
      basicId: typeof json.basicId === 'string' ? json.basicId : '',
    };
  } catch {
    return null;
  }
}

/** 今月のメッセージ送信数（LINE 側の実測値）。失敗は null（best-effort 表示用）。 */
export async function getQuotaConsumption(accessToken: string): Promise<number | null> {
  try {
    const res = await lineFetch('/v2/bot/message/quota/consumption', accessToken);
    if (!res.ok) return null;
    const json = (await res.json()) as { totalUsage?: unknown };
    return typeof json.totalUsage === 'number' ? json.totalUsage : null;
  } catch {
    return null;
  }
}

/** メッセージ本体（画像等）は api-data.line.me 側。api.line.me では取れない。 */
const LINE_DATA_API_BASE = 'https://api-data.line.me';

/** 領収書として扱う画像の上限。これを超えるものは読まずに捨てる。 */
export const MAX_LINE_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export type LineContentResult =
  | { ok: true; base64: string; mediaType: string; bytes: number }
  | { ok: false; reason: 'FETCH_FAILED' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' };

/**
 * LINE に届いた画像の本体を取得する。
 *
 * ⚠️ 取得した画像は**保存しない**。呼び出し側でその場で読み取りに使って捨てる。
 *    保管すると電子帳簿保存法の保管要件を背負うことになる。
 * ⚠️ Content-Length を信用せず、実際に読んだバイト数でも上限を確認する
 *    （ヘッダは相手が自由に付けられる）。
 */
export async function fetchLineMessageContent(
  accessToken: string,
  messageId: string,
): Promise<LineContentResult> {
  try {
    const res = await fetch(`${LINE_DATA_API_BASE}/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, reason: 'FETCH_FAILED' };

    const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return { ok: false, reason: 'UNSUPPORTED_TYPE' };

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_LINE_IMAGE_BYTES) return { ok: false, reason: 'TOO_LARGE' };

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_LINE_IMAGE_BYTES) return { ok: false, reason: 'TOO_LARGE' };

    return { ok: true, base64: buf.toString('base64'), mediaType, bytes: buf.byteLength };
  } catch {
    // ⚠️ エラーの中身をログにも戻り値にも載せない（URL に messageId が含まれる）
    return { ok: false, reason: 'FETCH_FAILED' };
  }
}
