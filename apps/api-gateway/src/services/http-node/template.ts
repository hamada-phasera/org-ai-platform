// カスタム HTTP ノードのテンプレート展開と出力抽出。すべて pure（テスト対象）。
//
// 展開規則は step-runner.ts の renderArgTemplate と同じ思想:
// 「未宣言のプレースホルダを空文字に静かに展開しない」「文字列連結で JSON を組まない」。
// 静かな展開は `https://api.x/users/` のような別 URL を叩く事故になり、
// 文字列連結の JSON は素直にインジェクション面になる。

import type { HttpNodeParam } from '@org-ai/shared-types';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}/g;
const WHOLE_PLACEHOLDER_RE = /^\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}$/;
/** ヘッダ値に混ぜてはいけない文字（CR/LF を含む制御文字）。 */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/** 1 パラメータ値の上限（展開爆発を防ぐ） */
const MAX_VALUE_BYTES = 64 * 1024;
/** 展開後ボディの上限 */
const MAX_BODY_BYTES = 256 * 1024;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

function readParam(params: Record<string, unknown>, name: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(params, name)) {
    // 空文字へ静かに展開すると別の宛先を叩いてしまう。必ず失敗させる。
    throw new TemplateError(`パラメータ {{${name}}} が渡されていません`);
  }
  return params[name];
}

function asText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_VALUE_BYTES) {
    throw new TemplateError('パラメータの値が大きすぎます');
  }
  return text;
}

/** URL に埋める値は必ずパーセントエンコードする（path 分割・クエリ注入を防ぐ）。 */
export function expandUrlTemplate(tpl: string, params: Record<string, unknown>): string {
  return tpl.replace(PLACEHOLDER_RE, (_m, name: string) =>
    encodeURIComponent(asText(readParam(params, name))),
  );
}

/** ヘッダ値に CR/LF・制御文字が入るとヘッダインジェクションになるので必ず落とす。 */
export function expandHeaderValue(tpl: string, params: Record<string, unknown>): string {
  const out = tpl.replace(PLACEHOLDER_RE, (_m, name: string) => asText(readParam(params, name)));
  if (CONTROL_CHAR_RE.test(out)) {
    throw new TemplateError('ヘッダの値に改行や制御文字を含めることはできません');
  }
  return out;
}

/**
 * body テンプレートを展開する。オブジェクト/配列を再帰的に辿り、
 * **文字列リーフがちょうど `"{{p}}"` のときだけ値の型を保ったまま差し込む**
 * （配列・数値・真偽値が文字列に潰れない）。文字列の一部なら補間して文字列のまま。
 * 文字列連結で JSON を組み立てないので、JSON インジェクションが原理的に起きない。
 */
export function expandBody(tpl: unknown, params: Record<string, unknown>): unknown {
  const expanded = expandNode(tpl, params);
  const size = Buffer.byteLength(JSON.stringify(expanded ?? null), 'utf8');
  if (size > MAX_BODY_BYTES) throw new TemplateError('リクエスト本文が大きすぎます');
  return expanded;
}

function expandNode(node: unknown, params: Record<string, unknown>): unknown {
  if (typeof node === 'string') {
    const whole = node.match(WHOLE_PLACEHOLDER_RE);
    if (whole) return readParam(params, whole[1]); // 型を保つ
    return node.replace(PLACEHOLDER_RE, (_m, name: string) => asText(readParam(params, name)));
  }
  if (Array.isArray(node)) return node.map((n) => expandNode(n, params));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = expandNode(v, params);
    return out;
  }
  return node;
}

/** テンプレート中のプレースホルダ名を列挙する（保存時の宣言漏れ検査用）。 */
export function collectPlaceholders(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER_RE)) into.add(m[1]);
    return into;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => collectPlaceholders(v, into));
    return into;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((v) => collectPlaceholders(v, into));
  }
  return into;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * レスポンスから値を取り出す。`a.b.c` / `a.items[0].id` / `a.0.b` を受ける。
 * 解決できないパスは undefined を返す（呼び出し側がエラーにする。
 * ここで success 扱いにすると {{prev}} が黙って空になり、後続が原因不明で壊れる）。
 */
export function pickOutput(data: unknown, path: string | null | undefined): unknown {
  if (!path) return data;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = data;
  for (const seg of segments) {
    if (UNSAFE_KEYS.has(seg)) return undefined; // プロトタイプ汚染の経路を塞ぐ
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** params 宣言から JSON Schema を生成する（ユーザーに JSON Schema を書かせない）。 */
export function buildInputSchema(params: HttpNodeParam[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: 'object', required, properties, additionalProperties: false };
}

/** httpConfig から method を安全に読む。壊れていれば null（承認ゲートは fail-closed で扱う）。 */
export function httpMethodOf(httpConfig: unknown): string | null {
  if (!httpConfig || typeof httpConfig !== 'object') return null;
  const method = (httpConfig as { method?: unknown }).method;
  return typeof method === 'string' ? method.toUpperCase() : null;
}
