// Slack Web API の薄いクライアント（SDK 不使用）。inbox/line-client.ts と同じ流儀:
// fetch + AbortSignal.timeout、throw せず戻り値で失敗を返し、呼び出し側が判断する。
// ⚠️ ログ・戻り値の message に Bot トークン（平文・暗号文とも）を絶対に含めないこと。

const SLACK_API_BASE = 'https://slack.com/api';
const API_TIMEOUT_MS = 10_000;

function slackFetch(path: string, botToken: string, body?: unknown): Promise<Response> {
  return fetch(`${SLACK_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
}

export interface SlackAuthInfo {
  teamId: string;
  teamName: string;
  botUserId: string;
  /** x-oauth-scopes レスポンスヘッダ（カンマ区切りを配列化） */
  scopes: string[];
}

/** Bot トークンの検証。接続登録時に使う。失敗は null（トークン不正 / 到達不可）。 */
export async function authTest(botToken: string): Promise<SlackAuthInfo | null> {
  try {
    const res = await slackFetch('/auth.test', botToken);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ok?: boolean;
      team_id?: unknown;
      team?: unknown;
      user_id?: unknown;
    };
    if (!json.ok || typeof json.team_id !== 'string') return null;
    const scopesHeader = res.headers.get('x-oauth-scopes') ?? '';
    return {
      teamId: json.team_id,
      teamName: typeof json.team === 'string' ? json.team : '',
      botUserId: typeof json.user_id === 'string' ? json.user_id : '',
      scopes: scopesHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

export type SlackPostResult =
  | { ok: true; channel: string; ts: string }
  | { ok: false; error: string; authDead: boolean };

/** これらの Slack エラーはトークン自体が死んでいる = 再接続が必要。 */
const AUTH_DEAD_ERRORS = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed']);

/** chat.postMessage。channel は '#name' / 名前 / ID のいずれも Slack 側が解決する。 */
export async function postMessage(
  botToken: string,
  channel: string,
  text: string,
): Promise<SlackPostResult> {
  try {
    const res = await slackFetch('/chat.postMessage', botToken, { channel, text });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: unknown;
      channel?: unknown;
      ts?: unknown;
    } | null;
    if (json?.ok) {
      return {
        ok: true,
        channel: typeof json.channel === 'string' ? json.channel : channel,
        ts: typeof json.ts === 'string' ? json.ts : '',
      };
    }
    const error = typeof json?.error === 'string' ? json.error : `http_${res.status}`;
    return { ok: false, error, authDead: AUTH_DEAD_ERRORS.has(error) };
  } catch (e) {
    const isTimeout = (e as { name?: string })?.name === 'TimeoutError' || /timeout|abort/i.test(String(e));
    return { ok: false, error: isTimeout ? 'timeout' : 'network_error', authDead: false };
  }
}
