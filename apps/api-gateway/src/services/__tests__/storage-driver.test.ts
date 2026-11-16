import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeDriver, readDriver, currentDriverName, resetStorageDrivers } from '../storage/driver';

const SAVED = { ...process.env };

beforeEach(() => {
  process.env = { ...SAVED };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NODE_ENV;
  resetStorageDrivers();
});

afterEach(() => {
  process.env = { ...SAVED };
  resetStorageDrivers();
  vi.restoreAllMocks();
});

describe('storage driver の選択', () => {
  it('Supabase 未設定なら local', () => {
    expect(currentDriverName()).toBe('local');
    expect(writeDriver().name).toBe('local');
  });

  it('Supabase が設定されていれば supabase', () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    expect(currentDriverName()).toBe('supabase');
    expect(writeDriver().name).toBe('supabase');
  });

  it('URL だけ・キーだけでは supabase にしない', () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    expect(currentDriverName()).toBe('local');
  });

  it('readDriver は行に記録された driver を使う（local 行は local のまま）', () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    expect(readDriver('local').name).toBe('local');
    expect(readDriver('supabase').name).toBe('supabase');
  });

  it('supabase 行なのに設定が無ければ例外（黙ってローカルを読まない）', () => {
    expect(() => readDriver('supabase')).toThrow('このファイルの保存先に接続できません');
  });

  it('本番でローカルに落ちるときは1回だけ警告する', () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeDriver();
    writeDriver();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[storage\] SUPABASE_URL/);
  });

  it('開発ではローカルでも警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeDriver();
    expect(warn).not.toHaveBeenCalled();
  });
});
