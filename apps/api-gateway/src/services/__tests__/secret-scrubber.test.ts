import { describe, it, expect } from 'vitest';
import { scrubSecrets } from '../secret-scrubber';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('secret-scrubber / マスクすべきもの', () => {
  it('Authorization ヘッダの Bearer トークンは "Bearer " を残して伏せる', () => {
    const r = scrubSecrets('curl -H "Authorization: Bearer sk_live_51H8xYzAbCdEf" https://api.example.com/v1/charges');
    expect(r.found).toBe(true);
    expect(r.kinds).toContain('BEARER');
    expect(r.text).toContain('Bearer [REDACTED_BEARER]');
    expect(r.text).not.toContain('sk_live_51H8xYzAbCdEf');
    // ヘッダ名と URL は壊さない
    expect(r.text).toContain('Authorization:');
    expect(r.text).toContain('https://api.example.com/v1/charges');
  });

  it('Anthropic の sk-ant- キーを伏せる', () => {
    const r = scrubSecrets('キーは sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 です');
    expect(r.kinds).toContain('ANTHROPIC_KEY');
    expect(r.text).toBe('キーは [REDACTED_ANTHROPIC_KEY] です');
  });

  it('OpenAI 系の sk- キーを伏せる', () => {
    // ⚠️ ベタ書きしない（GitHub の secret scanning が本物と判定して push が止まる）
    const key = ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUv1234'].join('-');
    const r = scrubSecrets(`OPENAI_API_KEY=${key}`);
    expect(r.found).toBe(true);
    expect(r.text).not.toContain(key);
  });

  it('Slack トークン (xoxb- / xapp-) を伏せる', () => {
    const bot = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
    const appToken = ['xapp', '1', 'A01234567', '1234567890123', 'abcdef'].join('-');
    const r = scrubSecrets(`${bot} と ${appToken}`);
    expect(r.kinds).toContain('SLACK_TOKEN');
    expect(r.text).not.toContain(bot);
    expect(r.text).not.toContain(appToken);
  });

  it('GitHub トークン (ghp_ / github_pat_) を伏せる', () => {
    const classic = ['ghp', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('_');
    const fineGrained = ['github', 'pat', '11ABCDEFG0abcdefghijklmnop'].join('_');
    const r = scrubSecrets(`${classic} / ${fineGrained}`);
    expect(r.kinds).toContain('GITHUB_TOKEN');
    expect(r.text).not.toContain(classic);
    expect(r.text).not.toContain(fineGrained);
  });

  it('AWS アクセスキー ID を伏せる', () => {
    const keyId = ['AKIAIOSFOD', 'NN7EXAMPLE'].join('');
    const r = scrubSecrets(`AWS_ACCESS_KEY_ID=${keyId}`);
    expect(r.kinds).toContain('AWS_ACCESS_KEY_ID');
    expect(r.text).not.toContain(keyId);
  });

  it('Google API キー (AIza + 35) を伏せる', () => {
    const key = `AIzaSyD-${'abcdefghijklmnopqrstuvwxyz'}01234`; // AIza + 35 文字
    const r = scrubSecrets(`Gemini のキー: ${key}`);
    expect(r.kinds).toContain('GOOGLE_API_KEY');
    expect(r.text).toBe('Gemini のキー: [REDACTED_GOOGLE_API_KEY]');
  });

  it('LINE の長期チャネルアクセストークン (長い base64) を伏せる', () => {
    const token = `${'Ab3'.repeat(50)}=`; // 150 文字 + パディング
    const r = scrubSecrets(`CHANNEL_ACCESS_TOKEN\n${token}`);
    expect(r.kinds).toContain('LINE_CHANNEL_TOKEN');
    expect(r.text).not.toContain(token);
  });

  it('汎用 key=value 形式 (api_key / token / secret / password) を伏せる', () => {
    const cases = [
      '{"api_key": "abcd1234efgh5678"}',
      'X-API-KEY: abcd1234efgh5678',
      'password=Sup3rSecretValue',
      "client_secret='abcd1234efgh5678'",
      'token = abcd1234efgh5678',
    ];
    for (const c of cases) {
      const r = scrubSecrets(c);
      expect(r.found, c).toBe(true);
      expect(r.text, c).not.toContain('abcd1234efgh5678');
      expect(r.text, c).not.toContain('Sup3rSecretValue');
    }
    // 引用符やキー名は壊さない
    expect(scrubSecrets('{"api_key": "abcd1234efgh5678"}').text)
      .toBe('{"api_key": "[REDACTED_GENERIC_SECRET]"}');
  });

  it('クエリ文字列の token= も伏せるが URL 本体は残す', () => {
    const r = scrubSecrets('https://example.com/webhook?token=abcd1234efgh5678');
    expect(r.found).toBe(true);
    expect(r.text).toContain('https://example.com/webhook?token=');
    expect(r.text).not.toContain('abcd1234efgh5678');
  });

  it('十分に長い base64 / hex 文字列を伏せる', () => {
    const b64 = 'Ab3'.repeat(14); // 42 文字・小文字/大文字/数字すべて含む
    const hex = 'a1b2c3d4e5'.repeat(4); // 40 文字
    const rb = scrubSecrets(`トークン: ${b64}`);
    expect(rb.kinds).toContain('BASE64_TOKEN');
    expect(rb.text).not.toContain(b64);
    const rh = scrubSecrets(`シークレット ${hex} を使います`);
    expect(rh.kinds).toContain('HEX_TOKEN');
    expect(rh.text).toBe('シークレット [REDACTED_HEX_TOKEN] を使います');
  });

  it('curl 全体を貼られても資格情報だけが消えて構造は残る', () => {
    const curl = [
      'curl -X POST https://api.example.com/v1/messages \\',
      '  -H "x-api-key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" \\',
      '  -H "content-type: application/json" \\',
      '  -d \'{"model":"claude-sonnet-4","max_tokens":1024}\'',
    ].join('\n');
    const r = scrubSecrets(curl);
    expect(r.found).toBe(true);
    expect(r.text).not.toContain('sk-ant-api03');
    expect(r.text).toContain('curl -X POST https://api.example.com/v1/messages');
    expect(r.text).toContain('content-type: application/json');
    expect(r.text).toContain('"model":"claude-sonnet-4"');
  });

  it('kinds は重複なしで返る', () => {
    const r = scrubSecrets('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA と sk-ant-api03-BBBBBBBBBBBBBBBBBBBB');
    expect(r.kinds).toEqual(['ANTHROPIC_KEY']);
  });

  it('冪等: 2 回 scrub しても結果が変わらない', () => {
    const once = scrubSecrets('Authorization: Bearer sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv');
    const twice = scrubSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.found).toBe(false);
  });
});

describe('secret-scrubber / 壊してはいけないもの', () => {
  const SAFE = [
    // 普通の日本語文
    '経理部のエージェントに毎月の請求書処理をお願いしたいです。',
    'パスワードは忘れてしまったので、再発行の手順を教えてください。',
    'この API を叩くワークフローを作ってください。トークンは後で登録します。',
    // 通常の URL
    'https://example.com/path',
    'https://api.example.com/v1/users?limit=20&offset=0',
    `https://cdn.example.com/assets/${'Ab3'.repeat(15)}.png`, // 45 文字のパス片
    // 短い英数字
    '注文 ID は A1B2C3 です',
    'sk-123',
    'ver 1.2.3-beta',
    // 英文の中の Bearer / token
    'Bearer authentication is required for this endpoint.',
    'The token is stored in the environment variables.',
    // 値がリテラルのもの
    'token: null',
    'secret = undefined',
    'password: false',
    // 閾値未満のランダム文字列
    `id=${'Ab3'.repeat(13)}`.slice(0, 42), // 39 文字
    // data URI
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ];

  for (const s of SAFE) {
    it(`変更しない: ${s.slice(0, 40)}`, () => {
      const r = scrubSecrets(s);
      expect(r.text).toBe(s);
      expect(r.found).toBe(false);
      expect(r.kinds).toEqual([]);
    });
  }

  it('空文字は素通し', () => {
    expect(scrubSecrets('')).toEqual({ text: '', found: false, kinds: [] });
  });

  it('普通の日本語文の中に混ざったキーだけを消す', () => {
    const r = scrubSecrets('APIキーは sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv です。よろしくお願いします。');
    expect(r.text).toBe('APIキーは [REDACTED_ANTHROPIC_KEY] です。よろしくお願いします。');
  });
});

/**
 * 共有フィクスチャによる契約テスト。
 *
 * 同じ JSON を ai-engine 側（tests/test_pii_screener_credentials.py）も読む。
 * 二段構えの防御は、二段目が一段目と同じ盲点を持っていたら二重防御にならないので、
 * 片方にだけ規則を足すともう片方が落ちるようにしてある。
 */
describe('共有フィクスチャ（ai-engine と同じ期待）', () => {
  interface Assembled {
    join: string;
    parts: string[];
  }
  interface MaskCase {
    name: string;
    textTemplate: string;
    assemble: Record<string, Assembled>;
    mustVanish: string[];
  }

  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../tests/fixtures/credential-samples.json'), 'utf8'),
  ) as {
    mustMask: MaskCase[];
    mustNotMask: Array<{ name: string; text: string }>;
  };

  /**
   * 断片を結合して本文と「消えるべき値」を組み立てる。
   * ⚠️ フィクスチャにベタ書きしないのは、本物そっくりの形が必要な一方で、
   *    そのまま書くと GitHub の secret scanning が本物と判定して push が止まるため。
   */
  function build(c: MaskCase): { text: string; secrets: string[] } {
    const values: Record<string, string> = {};
    for (const [key, a] of Object.entries(c.assemble)) values[key] = a.parts.join(a.join);
    let text = c.textTemplate;
    for (const [key, v] of Object.entries(values)) text = text.split(`{{${key}}}`).join(v);
    return { text, secrets: c.mustVanish.map((k) => values[k]) };
  }

  it.each(fixture.mustMask)('マスクする: $name', (c) => {
    const { text, secrets } = build(c);
    const r = scrubSecrets(text);
    for (const secret of secrets) expect(r.text).not.toContain(secret);
    expect(r.found).toBe(true);
  });

  it.each(fixture.mustNotMask)('マスクしない: $name', ({ text }) => {
    expect(scrubSecrets(text).text).toBe(text);
  });

  it('2回かけても壊れない（冪等）', () => {
    for (const c of fixture.mustMask) {
      const once = scrubSecrets(build(c).text).text;
      expect(scrubSecrets(once).text).toBe(once);
    }
  });
})
