/**
 * secret-scrubber — 資格情報らしき文字列のマスク
 *
 * 目的: チャット本文に混入した API キー / トークンを
 *   (a) LLM (Anthropic / Gemini) に送る前
 *   (b) Message テーブル・AILog に保存する前
 * にマスクして、外部クラウドと DB に平文を残さない。
 *
 * 実キーは確認カードの専用入力欄 → gateway 直送 → sealSecret の経路だけで渡る想定なので、
 * チャットに出てきた値はマスクして構わない（履歴からも消えるのが正しい）。
 *
 * 設計方針:
 * - pure / 副作用なし。入力を書き換えず新しい文字列を返す。
 * - 誤検出で普通の日本語文・URL・短い英数字列を壊さないことを最優先にする。
 *   そのため汎用パターン (base64 / hex) は 40 文字以上・文字種 3 クラス必須などの
 *   保守的な閾値と、URL の途中を拾わないための境界 (lookbehind) を置いている。
 * - 冪等: 置換後の `[REDACTED_*]` は角括弧を含み、どのパターンの文字クラスにも入らないため
 *   2 回 scrub しても壊れない。
 */

export interface ScrubResult {
  /** マスク後のテキスト */
  text: string;
  /** 1 つ以上マスクしたか */
  found: boolean;
  /** マスクした種別 (重複なし・検出順) */
  kinds: string[];
}

interface Rule {
  kind: string;
  re: RegExp;
  /** 置換文字列を返す。null を返すとそのマッチは置換しない（誤検出回避のための後段チェック用）。 */
  replacer: (m: RegExpExecArray) => string | null;
}

/** 汎用 key=value で「値ではない」ことが明らかなリテラル */
const NON_SECRET_VALUES = new Set([
  'null', 'undefined', 'true', 'false', 'none', 'nil', 'empty', 'nan',
  'string', 'number', 'boolean', 'object', 'value',
]);

/** 小文字・大文字・数字のうち何クラス含むか */
function charClassCount(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n += 1;
  if (/[A-Z]/.test(s)) n += 1;
  if (/[0-9]/.test(s)) n += 1;
  return n;
}

const RULES: Rule[] = [
  // --- プロバイダ固有（先に具体的なものから） ---
  {
    // Anthropic: sk-ant-api03-xxxx
    kind: 'ANTHROPIC_KEY',
    re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
    replacer: () => '[REDACTED_ANTHROPIC_KEY]',
  },
  {
    // OpenAI 系: sk-xxxx / sk-proj-xxxx（sk-ant- は上で処理済み）
    kind: 'OPENAI_KEY',
    re: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacer: () => '[REDACTED_OPENAI_KEY]',
  },
  {
    // Stripe: sk_live_… / sk_test_… / rk_live_…（アンダースコア区切りなので sk- 規則に当たらない）
    // pk_ は公開可能キーなので伏せない（伏せると会話が読めなくなるだけで守る対象でもない）
    kind: 'STRIPE_KEY',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replacer: () => '[REDACTED_STRIPE_KEY]',
  },
  {
    // SendGrid: SG.<id>.<secret>。ドット区切りなので汎用 base64 規則の lookbehind に弾かれる
    kind: 'SENDGRID_KEY',
    re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    replacer: () => '[REDACTED_SENDGRID_KEY]',
  },
  {
    // Twilio: AC<32hex>（Account SID）/ SK<32hex>（API Key SID）。
    // 32 桁なので汎用 hex 規則（40 桁以上）では拾えない
    kind: 'TWILIO_SID',
    re: /\b(?:AC|SK)[0-9a-fA-F]{32}\b/g,
    replacer: () => '[REDACTED_TWILIO_SID]',
  },
  {
    // Slack: xoxb- xoxp- xoxa- xoxr- xoxs- xoxe- / xapp-
    kind: 'SLACK_TOKEN',
    re: /\b(?:xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})/g,
    replacer: () => '[REDACTED_SLACK_TOKEN]',
  },
  {
    // GitHub: ghp_ gho_ ghu_ ghs_ ghr_ / github_pat_
    kind: 'GITHUB_TOKEN',
    re: /\b(?:gh[oprsu]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replacer: () => '[REDACTED_GITHUB_TOKEN]',
  },
  {
    // AWS アクセスキー ID: AKIA/ASIA + 大文字数字 16
    kind: 'AWS_ACCESS_KEY_ID',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacer: () => '[REDACTED_AWS_ACCESS_KEY_ID]',
  },
  {
    // Google API キー: AIza + 35 文字
    kind: 'GOOGLE_API_KEY',
    re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    replacer: () => '[REDACTED_GOOGLE_API_KEY]',
  },
  {
    // LINE 長期チャネルアクセストークン: 非常に長い base64 風（実物は 170 文字前後）
    kind: 'LINE_CHANNEL_TOKEN',
    re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{140,}={0,2}(?![A-Za-z0-9+/=])/g,
    replacer: () => '[REDACTED_LINE_CHANNEL_TOKEN]',
  },

  // --- ヘッダ形式 ---
  {
    // Authorization: Bearer xxxx —「Bearer 」は残してトークンだけ伏せる
    kind: 'BEARER',
    re: /\b([Bb]earer)([ \t]+)([A-Za-z0-9\-._~+/]+=*)/g,
    replacer: (m) => {
      const token = m[3];
      // 「Bearer authentication」のような普通の英文を壊さないための条件:
      // 8 文字以上かつ「数字を含む / 記号を含む / 20 文字以上」のいずれか。
      const looksLikeToken =
        token.length >= 8 &&
        (/[0-9]/.test(token) || /[-._~+/=]/.test(token) || token.length >= 20);
      if (!looksLikeToken) return null;
      return `${m[1]}${m[2]}[REDACTED_BEARER]`;
    },
  },

  {
    // Authorization: Basic <base64>
    kind: 'BASIC_AUTH',
    re: /\b([Bb]asic)([ \t]+)([A-Za-z0-9+/]{8,}={0,2})/g,
    replacer: (m) => {
      const token = m[3];
      // 「Basic authentication」のような普通の英文を壊さない。
      // base64 なら数字か記号を含むか、大文字小文字が混ざる
      const looksLikeBase64 =
        /[0-9+/=]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token));
      if (!looksLikeBase64) return null;
      return `${m[1]}${m[2]}[REDACTED_BASIC_AUTH]`;
    },
  },
  {
    // curl の -u / --user。Stripe も Twilio もこの形で貼られる。
    // 利用者名は残してパスワード側だけ伏せる（何の認証情報かは分かったほうがよい）
    kind: 'BASIC_AUTH_ARG',
    re: /(--user|-u)([ \t]+)(["']?)([^\s:"']{1,120}):([^\s"']{1,200})/g,
    replacer: (m) => `${m[1]}${m[2]}${m[3]}${m[4]}:[REDACTED_BASIC_AUTH]`,
  },
  {
    // https://user:password@host
    kind: 'URL_USERINFO',
    re: /(\bhttps?:\/\/)([^\s/@:]{1,120}):([^\s/@]{1,200})@/gi,
    replacer: (m) => `${m[1]}${m[2]}:[REDACTED_URL_PASSWORD]@`,
  },

  // --- 汎用 key = value ---
  {
    kind: 'GENERIC_SECRET',
    // ⚠️ 先頭は \b ではなく「英数字の直後でない」。\b だと SENDGRID_API_KEY の
    //    API_KEY 部分に境界が立たず（_ は語構成文字）、環境変数風の書き方を丸ごと取り逃す。
    re: /((?<![A-Za-z0-9])(?:api[-_ ]?key|apikey|access[-_ ]?token|auth[-_ ]?token|refresh[-_ ]?token|bearer[-_ ]?token|client[-_ ]?secret|secret[-_ ]?key|private[-_ ]?key|token|secret|password|passwd|pwd|credential)\s*["'`]?\s*[:=]\s*["'`]?)([A-Za-z0-9\-._~+/]{8,}=*)/gi,
    replacer: (m) => {
      const value = m[2];
      if (NON_SECRET_VALUES.has(value.toLowerCase())) return null;
      // URL は値ではなくエンドポイント指定であることが多いので伏せない
      if (/^https?:\/\//i.test(value)) return null;
      return `${m[1]}[REDACTED_GENERIC_SECRET]`;
    },
  },

  // --- 汎用の長いランダム文字列（誤検出回避のため強めの条件） ---
  {
    // 40 文字以上の base64 風。URL のパス片やファイル名を拾わないよう直前の文字を制限し、
    // さらに 小文字/大文字/数字 の 3 クラスすべてを含むものだけをトークンとみなす。
    kind: 'BASE64_TOKEN',
    re: /(?<!base64,)(?<![A-Za-z0-9+/\-_.])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g,
    replacer: (m) => (charClassCount(m[0].replace(/=+$/, '')) === 3 ? '[REDACTED_BASE64_TOKEN]' : null),
  },
  {
    // 40 文字以上の hex（API シークレット等）。URL 片・単語の一部は拾わない。
    kind: 'HEX_TOKEN',
    re: /(?<![A-Za-z0-9\-._/])[0-9a-fA-F]{40,}(?![0-9a-fA-F])/g,
    replacer: () => '[REDACTED_HEX_TOKEN]',
  },
];

function applyRule(text: string, rule: Rule): { text: string; hit: boolean } {
  const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
  let out = '';
  let last = 0;
  let hit = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const replacement = rule.replacer(m);
    if (replacement === null) continue; // 誤検出とみなして素通し
    out += text.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    hit = true;
  }
  out += text.slice(last);
  return { text: out, hit };
}

/**
 * 資格情報らしき文字列を `[REDACTED_<KIND>]` に置換する。pure・副作用なし。
 *
 * @example
 *   scrubSecrets('curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnop" https://x.test')
 *   // → { text: 'curl -H "Authorization: Bearer [REDACTED_ANTHROPIC_KEY]" https://x.test',
 *   //     found: true, kinds: ['ANTHROPIC_KEY'] }
 */
export function scrubSecrets(text: string): ScrubResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', found: false, kinds: [] };
  }

  let current = text;
  const kinds: string[] = [];

  for (const rule of RULES) {
    const { text: next, hit } = applyRule(current, rule);
    current = next;
    if (hit && !kinds.includes(rule.kind)) kinds.push(rule.kind);
  }

  return { text: current, found: kinds.length > 0, kinds };
}

/**
 * JSON 値の中の文字列リーフだけをマスクする。構造は保つ。
 *
 * 用途: カスタム HTTP ノードの応答を ExecutionLog に永続化する前。
 * 外部APIは平気で `{"access_token": "..."}` を返してくるし、
 * ExecutionLog は org のメンバーなら誰でも読める。
 *
 * ⚠️ 深さと要素数に上限を置く。応答は 256KB で打ち切られているとはいえ、
 *    深くネストした JSON で再帰が跳ねるのを防ぐ。
 */
export function scrubJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') return scrubSecrets(value).text;
  if (Array.isArray(value)) return value.slice(0, 1000).map((v) => scrubJson(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubJson(v, depth + 1);
    }
    return out;
  }
  return value;
}
