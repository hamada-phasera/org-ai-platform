/**
 * 貼られた文章が「外部APIの繋ぎ方」に見えるかを判定する。
 *
 * チャットから外部API接続を作れるようにするための入口判定。
 * ⚠️ 広く拾いすぎないこと。普通の会話のたびに提案を取りにいくと、
 *    毎回 LLM 往復ぶん待たせるだけで、体験がはっきり悪くなる。
 *    curl コマンドか、URL と認証ヘッダらしき語が揃っているときだけ拾う。
 */

const CURL_RE = /(^|\s)curl\s+/i;
const URL_RE = /https?:\/\/[^\s'"]+/i;
const AUTH_HINT_RE = /authorization|bearer\s|x-api-key|api[-_ ]?key|access[-_ ]?token/i;

/** 短すぎる文章は判断材料が足りないので拾わない。 */
const MIN_LENGTH = 30;

export function looksLikeApiSpec(text: string): boolean {
  if (typeof text !== 'string' || text.length < MIN_LENGTH) return false;
  if (CURL_RE.test(text)) return true;
  if (!URL_RE.test(text)) return false;
  return AUTH_HINT_RE.test(text);
}
