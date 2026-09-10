// カスタム HTTP ノードの実行。capability-executor から kind==='http' のときだけ呼ばれる。
//
// ⚠️ ログにもレスポンスにも、展開後の URL・ヘッダ・本文を出さない。
//    展開後 URL にはパラメータ（PII になりうる）が、ヘッダには API キーが載る。
//    出してよいのは capabilityId / host / method / statusCode / durationMs だけ。

import type { N8nEnvelope, ErrorType } from '../capability-executor';
import { openSecret } from '../secret-box';
import { checkRateLimit, sendGuardedRequest } from './client';
import { storedHttpConfigSchema } from './config-schema';
import {
  TemplateError,
  expandBody,
  expandHeaderValue,
  expandUrlTemplate,
  pickOutput,
} from './template';
import { assertSafeUrl } from './url-guard';

export interface HttpCapabilityRow {
  id?: string;
  name: string;
  httpConfig?: unknown;
}

function envelope(
  status: 'success' | 'error',
  errorType: ErrorType,
  message: string,
  data: unknown = null,
): N8nEnvelope {
  return { status, error_type: errorType, message, data };
}

/** HTTP ステータスをこのコードベースの作法（一時故障 vs 再接続要求）に写す。 */
export function classifyHttpStatus(
  statusCode: number,
  retryAfter?: string | null,
): { errorType: ErrorType; message: string; authDead: boolean } {
  if (statusCode === 401 || statusCode === 403) {
    return {
      errorType: 'AUTH_MISSING',
      message:
        'この外部APIの認証が拒否されました。ガバナンス > 外部API接続 から APIキーを更新してください。',
      authDead: true,
    };
  }
  if (statusCode === 429) {
    const wait = retryAfter ? `（${retryAfter} 秒後に再試行できます）` : '';
    return {
      errorType: 'RATE_LIMIT',
      message: `外部APIのレート制限に達しました${wait}。`,
      authDead: false,
    };
  }
  if (statusCode >= 500 || statusCode === 408 || statusCode === 425) {
    // 一時故障。再接続を促さない（設定は正しい）
    return {
      errorType: 'NODE_FAILED',
      message: '外部APIが一時的に応答できません。時間をおいて再度お試しください。',
      authDead: false,
    };
  }
  return {
    errorType: 'NODE_FAILED',
    message: `外部APIがエラーを返しました (HTTP ${statusCode})。設定またはリクエスト内容を確認してください。`,
    authDead: false,
  };
}

export interface ExecuteHttpResult {
  envelope: N8nEnvelope;
  /** 401/403 を掴んだ = 資格情報が死んでいる。呼び出し側が status を NEEDS_AUTH に落とす */
  authDead: boolean;
}

/**
 * カスタム HTTP ノードを実行する。
 *
 * 防御は2段構え:
 *   1. assertSafeUrl — 展開後 URL の静的検査（https / IP リテラル / 内部ホスト / ポート）
 *   2. createGuardedLookup（client.ts の Agent）— 実際に接続する IP のピン留め
 * **両方**通す必要がある。片方だけだと IP リテラルか DNS リバインディングのどちらかが素通りする。
 */
export async function executeHttpCapabilityDetailed(
  capability: HttpCapabilityRow,
  args: Record<string, unknown>,
  orgId: string,
): Promise<ExecuteHttpResult> {
  if ((process.env.HTTP_NODE_ENABLED ?? 'true') === 'false') {
    return {
      envelope: envelope('error', 'NODE_FAILED', 'カスタムノードの実行は現在停止されています。'),
      authDead: false,
    };
  }

  // DB を信用しない。壊れた設定で送信しない
  const parsed = storedHttpConfigSchema.safeParse(capability.httpConfig);
  if (!parsed.success) {
    return {
      envelope: envelope(
        'error',
        'VALIDATION_ERROR',
        'このノードの設定が壊れています。ガバナンス > 外部API接続 から設定し直してください。',
      ),
      authDead: false,
    };
  }
  const config = parsed.data;

  if (!checkRateLimit(orgId)) {
    return {
      envelope: envelope('error', 'RATE_LIMIT', '外部APIの呼び出しが多すぎます。少し待ってから再度お試しください。'),
      authDead: false,
    };
  }

  // テンプレート展開（未宣言プレースホルダ・ヘッダインジェクションはここで落ちる）
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;
  try {
    url = expandUrlTemplate(config.url, args);
    headers = {};
    for (const h of config.headers) {
      const rawValue = h.secret ? openSecret(h.value) : h.value;
      headers[h.name] = expandHeaderValue(rawValue, args);
    }
    body =
      config.method === 'GET' || !config.bodyTemplate
        ? undefined
        : expandBody(config.bodyTemplate, args);
  } catch (e) {
    const message =
      e instanceof TemplateError
        ? e.message
        : 'このノードの設定を展開できませんでした。設定を確認してください。';
    return { envelope: envelope('error', 'VALIDATION_ERROR', message), authDead: false };
  }

  // 展開後の URL を再検査（保存後に環境が変わった場合や、値で組み替えられた場合の最後の砦）
  const verdict = assertSafeUrl(url);
  if (!verdict.ok) {
    // ⚠️ 解決先や「内部だった」ことを利用者に返さない（内部ネットワークスキャナにしない）
    return {
      envelope: envelope('error', 'VALIDATION_ERROR', '接続先として許可されていない URL です。'),
      authDead: false,
    };
  }

  // ⚠️ HTTP ヘッダ名は大文字小文字を区別しない。利用者が 'Content-Type' を定義していると
  //    こちらが足す 'content-type' と両方送られ、相手によっては 400 になる。
  //    小文字に正規化してからマージし、送信側の指定を後勝ちにする。
  const normalizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) normalizedHeaders[k.toLowerCase()] = v;
  if (body !== undefined) normalizedHeaders['content-type'] = 'application/json';

  const startedAt = Date.now();
  const res = await sendGuardedRequest({
    url,
    method: config.method,
    headers: normalizedHeaders,
    body,
    timeoutMs: config.timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  // ログは宛先ホストまで。展開後 URL とヘッダは出さない
  console.log(
    `[http-node] ${capability.name} ${config.method} ${verdict.url.host} ` +
      `${res.ok ? res.statusCode : res.kind} ${durationMs}ms`,
  );

  if (!res.ok) {
    switch (res.kind) {
      case 'STATUS': {
        const c = classifyHttpStatus(res.statusCode, res.retryAfter);
        return { envelope: envelope('error', c.errorType, c.message), authDead: c.authDead };
      }
      case 'REDIRECT':
        return {
          envelope: envelope(
            'error',
            'NODE_FAILED',
            `リダイレクトは許可されていません (HTTP ${res.statusCode})。最終的な URL を直接指定してください。`,
          ),
          authDead: false,
        };
      case 'CONTENT_TYPE':
        return {
          envelope: envelope(
            'error',
            'NODE_FAILED',
            `扱えない形式の応答でした (${res.contentType || '不明'})。JSON かテキストを返す API を指定してください。`,
          ),
          authDead: false,
        };
      case 'TOO_LARGE':
        return {
          envelope: envelope('error', 'NODE_FAILED', '外部APIの応答が大きすぎます。'),
          authDead: false,
        };
      case 'TIMEOUT':
        return { envelope: envelope('error', 'TIMEOUT', '外部APIがタイムアウトしました。'), authDead: false };
      case 'NETWORK':
        // ⚠️ res.message をそのまま返さない（内部の解決結果が滲む）
        return {
          envelope: envelope('error', 'NODE_FAILED', '外部APIに接続できませんでした。'),
          authDead: false,
        };
      case 'BLOCKED':
        return {
          envelope: envelope('error', 'VALIDATION_ERROR', '接続先として許可されていない URL です。'),
          authDead: false,
        };
      default:
        return {
          envelope: envelope('error', 'NODE_FAILED', '外部APIに接続できませんでした。'),
          authDead: false,
        };
    }
  }

  if (res.body === null) {
    // 204 No Content など、本文なしの成功。送信は届いている
    if (config.outputPath) {
      return {
        envelope: envelope(
          'error',
          'NODE_FAILED',
          `外部APIは成功しましたが本文を返しませんでした (HTTP ${res.statusCode})。出力の取り出し方（${config.outputPath}）を空にしてください。`,
        ),
        authDead: false,
      };
    }
    return { envelope: envelope('success', null, '外部APIを呼び出しました', null), authDead: false };
  }

  const picked = pickOutput(res.body, config.outputPath);
  if (config.outputPath && picked === undefined) {
    // 黙って空にすると次ステップの {{prev}} が空になり、原因不明の失敗になる
    return {
      envelope: envelope(
        'error',
        'NODE_FAILED',
        `応答から「${config.outputPath}」を取り出せませんでした。出力の取り出し方を確認してください。`,
      ),
      authDead: false,
    };
  }

  return { envelope: envelope('success', null, '外部APIを呼び出しました', picked ?? null), authDead: false };
}
