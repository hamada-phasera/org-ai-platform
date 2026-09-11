import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageKey, keyBelongsToOrg } from '../../src/services/storage';
import { LocalStorageDriver } from '../../src/services/storage/local-driver';
import { SupabaseStorageDriver, supabaseConfigFromEnv } from '../../src/services/storage/supabase-driver';

describe('storageKey', () => {
  it('組織IDを先頭に置く', () => {
    expect(storageKey('org-1', 'f1', 'report.pdf')).toBe('org-1/f1_report.pdf');
  });

  it('名前に / や .. があっても、組織の区切りの外に出られない', () => {
    const key = storageKey('org-1', 'f1', '../../org-2/secret.pdf');
    expect(key.split('/')).toHaveLength(2);
    expect(keyBelongsToOrg(key, 'org-1')).toBe(true);
    expect(keyBelongsToOrg(key, 'org-2')).toBe(false);
  });

  it('先頭のドットは潰す（隠しファイル名にしない）', () => {
    expect(storageKey('org-1', 'f1', '.env').split('/')[1]).toBe('f1__env');
  });

  it('日本語のファイル名は残し、空白は _ にする', () => {
    expect(storageKey('org-1', 'f1', '見積書 第2版.pdf')).toBe('org-1/f1_見積書_第2版.pdf');
  });

  it('名前が空でもキーを作る', () => {
    expect(storageKey('org-1', 'f1', '')).toBe('org-1/f1_file');
  });

  it('長い名前は100文字で切る', () => {
    const key = storageKey('org-1', 'f1', 'a'.repeat(300));
    expect(key).toBe(`org-1/f1_${'a'.repeat(100)}`);
  });
});

describe('keyBelongsToOrg', () => {
  it('前方一致の取り違えをしない（org-1 と org-10）', () => {
    expect(keyBelongsToOrg('org-10/f_a.pdf', 'org-1')).toBe(false);
    expect(keyBelongsToOrg('org-1/f_a.pdf', 'org-1')).toBe(true);
  });
});

describe('LocalStorageDriver', () => {
  let base: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'flow-storage-'));
    driver = new LocalStorageDriver(base);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('保存したものを読める', async () => {
    await driver.put('org-1/f1_a.txt', Buffer.from('hello'), 'text/plain');
    expect((await driver.get('org-1/f1_a.txt'))?.toString()).toBe('hello');
  });

  it('無いものは null を返す（再デプロイで消えているのは既知の状態）', async () => {
    expect(await driver.get('org-1/missing.txt')).toBeNull();
  });

  it('無いものを消しても成功する', async () => {
    await expect(driver.delete('org-1/missing.txt')).resolves.toBeUndefined();
  });

  it('.. で保存先の外を読み書きさせない', async () => {
    await expect(driver.get('../../etc/passwd')).rejects.toThrow();
    await expect(driver.put('../escape.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    await expect(driver.delete('../escape.txt')).rejects.toThrow();
  });

  it('移行前の行（絶対パス）は、保存先の中なら読める', async () => {
    await mkdir(join(base, 'legacy'), { recursive: true });
    await writeFile(join(base, 'legacy', 'old.txt'), 'legacy');
    expect((await driver.get(join(base, 'legacy', 'old.txt')))?.toString()).toBe('legacy');
  });

  it('絶対パスでも保存先の外は拒否する', async () => {
    await expect(driver.get('/etc/passwd')).rejects.toThrow();
  });

  it('保存先と同じ接頭辞の兄弟ディレクトリを中とみなさない', async () => {
    await expect(driver.get(`${base}-evil/x.txt`)).rejects.toThrow();
  });
});

describe('SupabaseStorageDriver', () => {
  const cfg = { url: 'https://proj.supabase.co', serviceKey: 'service-role-test', bucket: 'org-files' };
  const fetchMock = vi.fn();
  const driver = new SupabaseStorageDriver(cfg);

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('キーの各セグメントをエンコードし、区切りの / は残す', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await driver.put('org-1/f1_見積 書.pdf', Buffer.from('x'), 'application/pdf');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://proj.supabase.co/storage/v1/object/org-files/org-1/${encodeURIComponent('f1_見積 書.pdf')}`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-upsert']).toBe('true');
    expect(init.headers['Content-Type']).toBe('application/pdf');
    expect(init.headers.Authorization).toBe('Bearer service-role-test');
  });

  it('取得: 本文を返す', async () => {
    fetchMock.mockResolvedValue(new Response('abc', { status: 200 }));
    expect((await driver.get('org-1/a.txt'))?.toString()).toBe('abc');
  });

  it('取得: 404 は null', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    expect(await driver.get('org-1/a.txt')).toBeNull();
  });

  it('取得: 400 + not_found（版によってはこう返る）も null', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400 }),
    );
    expect(await driver.get('org-1/a.txt')).toBeNull();
  });

  it('取得: バケットが無いのは「無い」ではなく失敗にする（設定ミスを隠さない）', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }), { status: 400 }),
    );
    await expect(driver.get('org-1/a.txt')).rejects.toThrow();
  });

  it('失敗のメッセージにキーもサービスキーも載せない（ログに流れる）', async () => {
    fetchMock.mockResolvedValue(new Response('boom org-1/secret.pdf', { status: 500 }));
    const err = (await driver.get('org-1/secret.pdf').catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('org-1');
    expect(err.message).not.toContain('service-role-test');
  });

  it('削除: 無いものは成功扱い', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    await expect(driver.delete('org-1/a.txt')).resolves.toBeUndefined();
  });

  it('削除: 権限エラーは失敗にする', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(driver.delete('org-1/a.txt')).rejects.toThrow();
  });
});

describe('supabaseConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('URL かキーが無ければ null（ローカルに落とす）', () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    expect(supabaseConfigFromEnv()).toBeNull();
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(supabaseConfigFromEnv()).toBeNull();
  });

  it('末尾のスラッシュを落とし、バケットの既定は org-files', () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.co/';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    delete process.env.SUPABASE_STORAGE_BUCKET;
    expect(supabaseConfigFromEnv()).toEqual({ url: 'https://proj.supabase.co', serviceKey: 'k', bucket: 'org-files' });
  });
});
