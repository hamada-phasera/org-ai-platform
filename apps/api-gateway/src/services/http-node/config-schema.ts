// カスタム HTTP ノード設定の検証と正規化。
//
// ⚠️ 「DB を信用しない」— 実行時にも必ずここで再パースする。DB は手編集や PATCH のバグで
//    壊れうるので、security-critical path における信頼できる入力ではない。

import { z } from 'zod';
import type { HttpNodeConfig, HttpNodeHeader } from '@org-ai/shared-types';
import { sealSecret } from '../secret-box';
import { collectPlaceholders } from './template';
import { validateUrlTemplate } from './url-guard';

/** 送信側が制御すべきで、ユーザーに指定させてはいけないヘッダ。 */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
]);

/**
 * 名前からして資格情報を運ぶヘッダ。`secret` が付いていなくても必ず封緘する。
 *
 * ⚠️ これが無いと、**LLM が返した `secret` boolean 1つ**で
 *    「暗号化して保存」か「平文のまま org 全員に配る」かが決まってしまう。
 *    GET /capabilities は requireAuth（OWNER 限定ではない）なので、
 *    secret:false のヘッダ値は sanitizeHttpConfig を素通りして全員のブラウザに届く。
 *    判断を LLM の一言に委ねてよい種類のことではないので、名前で機械的に決める。
 */
const CREDENTIAL_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey)$|(^|-)(auth|token|secret|key|credential|signature|sig|password|passwd)$/i;

/** そのヘッダは資格情報として扱うべきか。 */
export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADER_RE.test(name.trim().toLowerCase());
}

const paramSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, 'パラメータ名は英字で始まる英数字とアンダースコアのみです'),
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  required: z.boolean().default(false),
  description: z.string().max(200).optional(),
});

const headerInputSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'ヘッダ名の形式が不正です'),
  /** secret=true で value 省略なら、既存の封緘値を引き継ぐ（PATCH のとき） */
  value: z.string().max(4096).optional(),
  secret: z.boolean().default(false),
});

/** API が受け取る形（value は平文。保存時に seal する）。 */
export const httpNodeInputSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1).max(2048),
  headers: z.array(headerInputSchema).max(20).default([]),
  bodyEncoding: z.literal('json').optional(),
  bodyTemplate: z.record(z.unknown()).nullable().optional(),
  outputPath: z.string().max(200).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
});

/** DB に入っている形（value は secret のとき暗号文）。実行時の再パースに使う。 */
export const storedHttpConfigSchema = z.object({
  version: z.literal(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1).max(2048),
  headers: z
    .array(z.object({ name: z.string(), value: z.string(), secret: z.boolean().optional() }))
    .max(20),
  bodyEncoding: z.literal('json').optional(),
  bodyTemplate: z.record(z.unknown()).nullable().optional(),
  outputPath: z.string().nullable().optional(),
  timeoutMs: z.number().optional(),
  params: z.array(paramSchema).max(30),
});

export const paramsSchema = z.array(paramSchema).max(30);

export type HttpNodeInput = z.infer<typeof httpNodeInputSchema>;
export type HttpNodeParamInput = z.infer<typeof paramSchema>;

export type BuildResult =
  | { ok: true; config: HttpNodeConfig }
  | { ok: false; code: string; message: string };

/**
 * API 入力を保存形へ正規化する。
 *
 * - URL は静的検査（https / userinfo / ポート / IP リテラル / origin のプレースホルダ）を通す
 * - url・headers・bodyTemplate に出てくるプレースホルダが params に宣言済みかを検査する
 *   （宣言漏れを許すと実行時に別の宛先を叩く事故になる）
 * - secret ヘッダは**受け取った値を常に平文とみなして seal する**。
 *   `v1:` 始まりの事前封緘値は拒否する（他 org の暗号文を持ち込んで復号させる経路を塞ぐ。
 *   secret-box は AAD で orgId を束縛していないため）
 */
export function buildHttpConfig(
  input: HttpNodeInput,
  params: HttpNodeParamInput[],
  existingHeaders: HttpNodeHeader[] = [],
): BuildResult {
  const urlVerdict = validateUrlTemplate(input.url);
  if (!urlVerdict.ok) {
    return {
      ok: false,
      code: urlVerdict.reason,
      message:
        urlVerdict.reason === 'BLOCKED_DESTINATION'
          ? '接続先として許可されていない URL です。'
          : `URL が使えません（${urlVerdict.reason}）。${urlVerdict.detail}`,
    };
  }

  for (const h of input.headers) {
    if (FORBIDDEN_HEADERS.has(h.name.toLowerCase())) {
      return { ok: false, code: 'FORBIDDEN_HEADER', message: `ヘッダ ${h.name} は指定できません。` };
    }
  }

  const declared = new Set(params.map((p) => p.name));
  const used = collectPlaceholders(input.url);
  input.headers.forEach((h) => collectPlaceholders(h.value ?? '', used));
  if (input.bodyTemplate) collectPlaceholders(input.bodyTemplate, used);
  const missing = [...used].filter((n) => !declared.has(n));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'UNDECLARED_PARAM',
      message: `パラメータが宣言されていません: ${missing.join(', ')}`,
    };
  }

  // ⚠️ テンプレートに埋め込まれている以上、その param は事実上「必須」。
  //    required:false のまま保存すると、実行時に必ず TemplateError で落ちる
  //    （＝保存はできるが一度も動かないノードができる）。ここで必須に昇格させる。
  //    planner は使い所のある値を optional と判断しがちなので、拒否ではなく訂正にする。
  const effectiveParams = params.map((p) => (used.has(p.name) && !p.required ? { ...p, required: true } : p));

  const existingByName = new Map(existingHeaders.map((h) => [h.name.toLowerCase(), h]));
  const headers: HttpNodeHeader[] = [];
  for (const raw of input.headers) {
    // ⚠️ 名前が資格情報を示すなら、LLM や呼び出し側の申告に関わらず secret に格上げする。
    //    平文で保存すると org の全員が GET /capabilities で読めてしまう。
    const h = isCredentialHeader(raw.name) ? { ...raw, secret: true } : raw;
    if (!h.secret) {
      headers.push({ name: h.name, value: h.value ?? '', secret: false });
      continue;
    }
    if (h.value === undefined || h.value === '') {
      // PATCH で value 省略 = 既存の鍵を据え置く
      const prev = existingByName.get(h.name.toLowerCase());
      if (!prev) {
        return {
          ok: false,
          code: 'SECRET_REQUIRED',
          message: `ヘッダ ${h.name} の値を入力してください。`,
        };
      }
      headers.push({ name: h.name, value: prev.value, secret: true });
      continue;
    }
    if (h.value.startsWith('v1:')) {
      return {
        ok: false,
        code: 'SEALED_VALUE_NOT_ALLOWED',
        message: '暗号化済みの値は受け付けられません。元の値を入力してください。',
      };
    }
    if (h.value.includes('•')) {
      // 伏字がそのまま送り返されてきた（画面の表示値を鍵として保存する事故）
      return {
        ok: false,
        code: 'MASKED_VALUE_NOT_ALLOWED',
        message: '伏字のままでは保存できません。値を入力し直してください。',
      };
    }
    headers.push({ name: h.name, value: sealSecret(h.value), secret: true });
  }

  return {
    ok: true,
    config: {
      version: 1,
      method: input.method,
      url: input.url,
      headers,
      bodyEncoding: input.bodyEncoding ?? 'json',
      bodyTemplate: input.bodyTemplate ?? null,
      outputPath: input.outputPath ?? null,
      timeoutMs: input.timeoutMs ?? 15_000,
      params: effectiveParams,
    },
  };
}

/** レスポンス用の公開形。secret ヘッダの値を伏せる（暗号文も出さない）。 */
export function sanitizeHttpConfig(config: unknown): unknown {
  const parsed = storedHttpConfigSchema.safeParse(config);
  if (!parsed.success) return null;
  const c = parsed.data;
  return {
    version: c.version,
    method: c.method,
    url: c.url,
    bodyEncoding: c.bodyEncoding,
    bodyTemplate: c.bodyTemplate,
    outputPath: c.outputPath,
    timeoutMs: c.timeoutMs,
    params: c.params,
    headers: c.headers.map((h) => ({
      name: h.name,
      secret: !!h.secret,
      value: h.secret ? '••••••' : h.value,
    })),
  };
}
