// SSRF ガード（services/http-node/url-guard.ts）のテスト。
// prismaMock は不要（このモジュールは DB も外部 I/O も触らない）。
// env は import より前に整えるか、rebuildInternalHostDenylist() で作り直す。
import { describe, it, expect, vi, afterAll } from 'vitest';

// 開発シェルの env（AI_ENGINE_URL=http://localhost:8000 など）に結果が左右されないよう、
// モジュール読み込み前に内部ホスト系の env を空にしておく。
const ENV_KEYS = [
  'N8N_CLOUD_URL',
  'N8N_URL',
  'AI_ENGINE_URL',
  'API_GATEWAY_URL',
  'DATABASE_URL',
  'HTTP_NODE_BLOCKED_HOSTS',
  'HTTP_NODE_ALLOWED_PORTS',
] as const;
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  SAVED_ENV[key] = process.env[key];
  delete process.env[key];
}
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

const { classifyIp, validateUrlTemplate, assertSafeUrl, createGuardedLookup, rebuildInternalHostDenylist } =
  await import('../http-node/url-guard');

const reasonOf = (verdict: { ok: boolean } & Record<string, unknown>) =>
  verdict.ok ? 'OK' : (verdict.reason as string);

describe('classifyIp — 非公開/特殊用途レンジは拒否', () => {
  const blocked = [
    '127.0.0.1', // ループバック
    '0.0.0.0', // this network（多くのスタックで localhost 扱い）
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // クラウドメタデータ。ここが本丸
    '100.64.0.1', // CGNAT
    '224.0.0.1', // マルチキャスト
    '255.255.255.255', // ブロードキャスト（240/4）
    '::1',
    '::',
    'fc00::1',
    'fd12::1', // fc00::/7 に fd00::/8 が含まれること
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped: 埋め込み v4 を抽出して v4 規則で判定する必要がある
    '::ffff:7f00:1', // 同じアドレスの 16bit グループ表記
    '64:ff9b::a00:1', // NAT64 経由の 10.0.0.1
  ];
  for (const ip of blocked) {
    it(`拒否: ${ip}`, () => {
      expect(classifyIp(ip)).toMatchObject({ allowed: false });
    });
  }
});

describe('classifyIp — 公開レンジは許可（境界の 1 つ外側を含む）', () => {
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // 172.16/12 の 1 つ手前
    '172.32.0.1', // 172.16/12 の 1 つ後ろ
    '100.63.255.255', // 100.64/10 の 1 つ手前
    '100.128.0.1', // 100.64/10 の 1 つ後ろ
    '2606:4700::1111',
  ];
  for (const ip of allowed) {
    it(`許可: ${ip}`, () => {
      expect(classifyIp(ip)).toEqual({ allowed: true });
    });
  }
});

describe('validateUrlTemplate — 静的検査', () => {
  const cases: Array<[string, string]> = [
    ['http://api.x/', 'SCHEME_NOT_ALLOWED'], // 平文は API キーが素で流れる
    ['ftp://api.x/file', 'SCHEME_NOT_ALLOWED'],
    ['https://u:p@api.x/', 'USERINFO_NOT_ALLOWED'], // ホスト混同 + 資格情報のログ漏れ
    ['https://api.x:22/', 'PORT_NOT_ALLOWED'],
    ['https://127.0.0.1/', 'IP_LITERAL_NOT_ALLOWED'],
    ['https://0x7f000001/', 'IP_LITERAL_NOT_ALLOWED'], // WHATWG URL が 127.0.0.1 に正規化する
    ['https://[::1]/', 'IP_LITERAL_NOT_ALLOWED'],
    ['https://localhost/', 'BLOCKED_DESTINATION'], // 単一ラベル
    ['https://n8n/', 'BLOCKED_DESTINATION'], // コンテナ内サービス名
    ['https://foo.internal/', 'BLOCKED_DESTINATION'],
    ['https://{{host}}.example.com/', 'PLACEHOLDER_IN_ORIGIN'], // 宛先ホストの差し替えを許さない
  ];
  for (const [raw, reason] of cases) {
    it(`拒否 ${reason}: ${raw}`, () => {
      expect(reasonOf(validateUrlTemplate(raw) as never)).toBe(reason);
    });
  }

  it('拒否 URL_TOO_LONG: 2048 文字超', () => {
    const long = `https://api.example.com/${'a'.repeat(2100)}`;
    expect(long.length).toBeGreaterThan(2048);
    expect(reasonOf(validateUrlTemplate(long) as never)).toBe('URL_TOO_LONG');
  });

  it('許可: プレースホルダが path にあるのは OK（origin 外なので宛先は固定）', () => {
    const verdict = validateUrlTemplate('https://api.example.com/v1/deals/{{dealId}}');
    expect(verdict.ok).toBe(true);
  });

  it('許可: 8443 と query プレースホルダ', () => {
    const verdict = validateUrlTemplate('https://api.example.com:8443/x?q={{q}}');
    expect(verdict.ok).toBe(true);
  });

  it('8進/16進/10進の難読化はすべて IP リテラルとして落ちる', () => {
    for (const raw of ['https://0x7f.1/', 'https://2130706433/', 'https://017700000001/']) {
      expect(reasonOf(validateUrlTemplate(raw) as never)).toBe('IP_LITERAL_NOT_ALLOWED');
    }
  });

  it('userinfo を使ったホスト混同（@ の後ろが実際の宛先）を落とす', () => {
    expect(reasonOf(validateUrlTemplate('https://api.example.com@169.254.169.254/') as never)).toBe(
      'USERINFO_NOT_ALLOWED',
    );
  });
});

describe('assertSafeUrl — 実行時検査', () => {
  it('プレースホルダ規則以外は validateUrlTemplate と同じ', () => {
    expect(assertSafeUrl('https://api.example.com/v1/deals/42').ok).toBe(true);
    expect(reasonOf(assertSafeUrl('https://169.254.169.254/latest/meta-data/') as never)).toBe(
      'IP_LITERAL_NOT_ALLOWED',
    );
    expect(reasonOf(assertSafeUrl('http://api.example.com/') as never)).toBe('SCHEME_NOT_ALLOWED');
  });

  it('展開後に origin へプレースホルダは残らない前提なので、origin 規則は適用しない', () => {
    // origin にプレースホルダが残った URL はそもそもホスト名として不正 → MALFORMED ではなく
    // 「{{host}}.example.com」という名前のホスト扱いになるが、実行時はテンプレート検証済み。
    expect(assertSafeUrl('https://api.example.com/{{unexpanded}}').ok).toBe(true);
  });
});

describe('内部ホスト denylist（env 由来）', () => {
  it('公開 DNS 名の内部サービスは IP ブロックでは捕まらないので env で拒否する', () => {
    // 前提: ai.test は普通のホスト名なので、denylist に無ければ通る
    expect(validateUrlTemplate('https://ai.test/x').ok).toBe(true);
    // 解決先が公開 IP でも classifyIp は通してしまう＝IP ブロックは無力
    expect(classifyIp('93.184.216.34').allowed).toBe(true);

    process.env.AI_ENGINE_URL = 'https://ai.test';
    rebuildInternalHostDenylist();
    try {
      expect(reasonOf(validateUrlTemplate('https://ai.test/x') as never)).toBe('BLOCKED_DESTINATION');
      expect(reasonOf(assertSafeUrl('https://ai.test/x') as never)).toBe('BLOCKED_DESTINATION');
    } finally {
      delete process.env.AI_ENGINE_URL;
      rebuildInternalHostDenylist();
    }
    expect(validateUrlTemplate('https://ai.test/x').ok).toBe(true);
  });

  it('DATABASE_URL のホストも拒否する（postgres 直叩き防止）', () => {
    process.env.DATABASE_URL = 'postgresql://u:p@db.example.org:5432/app?sslmode=require';
    rebuildInternalHostDenylist();
    try {
      expect(reasonOf(assertSafeUrl('https://db.example.org/') as never)).toBe('BLOCKED_DESTINATION');
    } finally {
      delete process.env.DATABASE_URL;
      rebuildInternalHostDenylist();
    }
  });

  it('HTTP_NODE_BLOCKED_HOSTS で運用側が追加できる', () => {
    process.env.HTTP_NODE_BLOCKED_HOSTS = 'evil.example.com, other.example.com';
    rebuildInternalHostDenylist();
    try {
      expect(reasonOf(assertSafeUrl('https://evil.example.com/') as never)).toBe('BLOCKED_DESTINATION');
      expect(reasonOf(assertSafeUrl('https://other.example.com/') as never)).toBe('BLOCKED_DESTINATION');
    } finally {
      delete process.env.HTTP_NODE_BLOCKED_HOSTS;
      rebuildInternalHostDenylist();
    }
  });
});

describe('createGuardedLookup — DNS ピン留め', () => {
  type Addr = { address: string; family: number };
  const stubResolver = (addresses: Addr[] | Error) =>
    vi.fn((_hostname: string, _options: unknown, cb: (...args: unknown[]) => void) => {
      if (addresses instanceof Error) cb(addresses);
      else cb(null, addresses);
    });

  const run = (
    resolver: ReturnType<typeof stubResolver>,
    options: Record<string, unknown> = { all: true },
    hostname = 'api.example.com',
  ) =>
    new Promise<{ err: (Error & { code?: string }) | null; address: unknown; family: unknown }>((resolve) => {
      const lookup = createGuardedLookup(resolver as never);
      lookup(hostname, options as never, ((err: Error | null, address: unknown, family?: unknown) =>
        resolve({ err: err as never, address, family })) as never);
    });

  it('全部公開アドレスなら通す（all:true は配列で返す）', async () => {
    const resolver = stubResolver([{ address: '93.184.216.34', family: 4 }]);
    const { err, address } = await run(resolver);
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
    // 常に all:true / verbatim:true で引く（一部だけ見て通さないため）
    expect(resolver.mock.calls[0][1]).toMatchObject({ all: true, verbatim: true });
  });

  it('非公開アドレスならエラー', async () => {
    const { err } = await run(stubResolver([{ address: '169.254.169.254', family: 4 }]));
    expect(err).toBeTruthy();
    expect(err?.code).toBe('ERR_BLOCKED_DESTINATION');
  });

  it('公開+非公開が混ざったら「公開だけに絞る」ではなくホストごと拒否', async () => {
    const { err, address } = await run(
      stubResolver([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    );
    // Happy Eyeballs のフォールバックで非公開側に到達し得るため、絞り込みは不可
    expect(err).toBeTruthy();
    expect(err?.code).toBe('ERR_BLOCKED_DESTINATION');
    expect(address).toBe('');
  });

  it('IPv4-mapped の非公開アドレスも拒否（v6 の皮を被った 127.0.0.1）', async () => {
    const { err } = await run(stubResolver([{ address: '::ffff:7f00:1', family: 6 }]));
    expect(err?.code).toBe('ERR_BLOCKED_DESTINATION');
  });

  it('options.all が false なら (err, address, family) 形式で返す', async () => {
    const { err, address, family } = await run(
      stubResolver([{ address: '93.184.216.34', family: 4 }]),
      { all: false, family: 4 },
    );
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('DNS 解決失敗も BLOCKED_DESTINATION に畳む（内部スキャナにしない）', async () => {
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const { err } = await run(stubResolver(enotfound));
    expect(err?.code).toBe('ERR_BLOCKED_DESTINATION');
    expect(err?.code).not.toBe('ENOTFOUND');
  });

  it('リダイレクト等で内部ホスト名に飛んだ場合、DNS を引く前に拒否する', async () => {
    const resolver = stubResolver([{ address: '93.184.216.34', family: 4 }]);
    const { err } = await run(resolver, { all: true }, 'n8n');
    expect(err?.code).toBe('ERR_BLOCKED_DESTINATION');
    expect(resolver).not.toHaveBeenCalled();
  });
});
