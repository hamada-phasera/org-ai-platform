// どの保存先を使うかの決定点。ここ1か所だけが判断する。
//
// 新規の保存は Supabase（設定があれば）。無ければローカルに落ちる。
// 読み出しは **行に記録された driver** を使う。移行前の行は local のままなので、
// 全体を一斉に切り替えるのではなく、行ごとに正しい場所から読む。

import { join, resolve } from 'node:path';
import type { StorageDriver, StorageDriverName } from './index';
import { LocalStorageDriver } from './local-driver';
import { SupabaseStorageDriver, supabaseConfigFromEnv } from './supabase-driver';

const FILES_BASE = resolve(process.env.FILES_DIR ?? join(process.cwd(), '../../data/files'));

let supabase: SupabaseStorageDriver | null | undefined;
let local: LocalStorageDriver | undefined;
let warned = false;

function getSupabase(): SupabaseStorageDriver | null {
  if (supabase === undefined) {
    const cfg = supabaseConfigFromEnv();
    supabase = cfg ? new SupabaseStorageDriver(cfg) : null;
  }
  return supabase;
}

function getLocal(): LocalStorageDriver {
  if (!local) local = new LocalStorageDriver(FILES_BASE);
  return local;
}

/**
 * 新しく保存するときの保存先。
 *
 * ⚠️ 本番でローカルに落ちるのは事故なので、そのときは必ず警告を出す。
 *    黙ってローカルに書くと、次のデプロイでファイルが消えて初めて気づくことになる。
 */
export function writeDriver(): StorageDriver {
  const s = getSupabase();
  if (s) return s;
  if (process.env.NODE_ENV === 'production' && !warned) {
    warned = true;
    console.warn(
      '[storage] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。' +
        'ローカルディスクに保存しますが、Render では次のデプロイで実体が消えます。',
    );
  }
  return getLocal();
}

/** 行に記録された driver で読む。移行前の行（local）もそのまま読める。 */
export function readDriver(name: string): StorageDriver {
  if (name === 'supabase') {
    const s = getSupabase();
    if (!s) throw new Error('このファイルの保存先に接続できません');
    return s;
  }
  return getLocal();
}

export function currentDriverName(): StorageDriverName {
  return getSupabase() ? 'supabase' : 'local';
}

/** テスト用。env を変えたあとに呼ぶ。 */
export function resetStorageDrivers(): void {
  supabase = undefined;
  local = undefined;
  warned = false;
}
