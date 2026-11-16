import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractText } from '../fileExtractor';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'extract-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractText: テキスト', () => {
  it('Buffer の text/plain をそのまま返す', async () => {
    const r = await extractText(Buffer.from('こんにちは', 'utf8'), 'text/plain');
    expect(r).toEqual({ text: 'こんにちは', truncated: false, extractor: 'text' });
  });

  it('パスで渡した text/csv も読める', async () => {
    const p = join(dir, 'a.csv');
    await writeFile(p, 'a,b\n1,2\n');
    const r = await extractText(p, 'text/csv');
    expect(r.text).toBe('a,b\n1,2\n');
    expect(r.extractor).toBe('text');
  });

  it('maxChars を超えたら切り詰めて truncated=true', async () => {
    const r = await extractText(Buffer.from('abcdefghij'), 'text/plain', { maxChars: 4 });
    expect(r).toEqual({ text: 'abcd', truncated: true, extractor: 'text' });
  });

  it('既定の上限は 20,000 文字', async () => {
    const r = await extractText(Buffer.from('x'.repeat(20_001)), 'text/plain');
    expect(r.text).toHaveLength(20_000);
    expect(r.truncated).toBe(true);
  });

  it('ちょうど上限なら切り詰めない', async () => {
    const r = await extractText(Buffer.from('abcd'), 'text/plain', { maxChars: 4 });
    expect(r.truncated).toBe(false);
  });
});

describe('extractText: 未対応', () => {
  it('未対応の MIME は unsupported と理由を返す（例外にしない）', async () => {
    const r = await extractText(Buffer.from([0, 1, 2]), 'image/png');
    expect(r.extractor).toBe('unsupported');
    expect(r.truncated).toBe(false);
    expect(r.text).toContain('image/png');
  });

  it('壊れた PDF は unsupported（失敗理由つき）', async () => {
    const r = await extractText(Buffer.from('not a pdf'), 'application/pdf');
    expect(r.extractor).toBe('unsupported');
  });
});
