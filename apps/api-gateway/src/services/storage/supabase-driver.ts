// Supabase Storage の薄いクライアント。SDK は入れず REST を直接叩く。
//
// 使う API は4本だけ:
//   PUT    /storage/v1/object/{bucket}/{key}
//   GET    /storage/v1/object/{bucket}/{key}
//   DELETE /storage/v1/object/{bucket}/{key}
//   POST   /storage/v1/object/sign/{bucket}/{key}
//
// ⚠️ service_role キーを使う。これは RLS を貫通するので、**org の切り分けは
//    アプリ側の責任**になる（storageKey が orgId を先頭に置き、
//    keyBelongsToOrg で確認してから触る）。キーはログにも戻り値にも出さない。

import type { PutResult, StorageDriver } from './index';

const TIMEOUT_MS = 30_000;

export interface SupabaseStorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

/** 環境変数から設定を読む。足りなければ null（呼び出し側がローカルに落とす）。 */
export function supabaseConfigFromEnv(): SupabaseStorageConfig | null {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'org-files';
  if (!url || !serviceKey) return null;
  return { url, serviceKey, bucket };
}

/**
 * 「無い」の判定。
 * ⚠️ Supabase Storage は版によって、無いオブジェクトに 404 ではなく
 *    400 + 本文 {"statusCode":"404","error":"not_found"} を返す。status だけで見ると、
 *    消えたファイルが「取得に失敗」になり、削除は何度やっても失敗し続ける。
 * ⚠️ バケットが無いときも statusCode は 404 になる。これを「無い」扱いにすると
 *    設定ミスが黙って隠れるので、bucket を含むエラーは除外する。
 */
async function isNotFound(res: Response): Promise<boolean> {
  if (res.status === 404) return true;
  if (res.status !== 400) return false;
  try {
    const body = (await res.clone().json()) as { statusCode?: string | number; error?: string };
    const error = String(body.error ?? '').toLowerCase();
    if (error.includes('bucket')) return false;
    return String(body.statusCode) === '404' || error === 'not_found';
  } catch {
    return false;
  }
}

export class SupabaseStorageDriver implements StorageDriver {
  readonly name = 'supabase' as const;

  constructor(private readonly cfg: SupabaseStorageConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.serviceKey}`,
      apikey: this.cfg.serviceKey,
      ...extra,
    };
  }

  private objectUrl(key: string): string {
    // キーの各セグメントをエンコードする。/ は区切りとして残す
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${this.cfg.url}/storage/v1/object/${this.cfg.bucket}/${encoded}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await fetch(this.objectUrl(key), {
      method: 'POST',
      headers: this.headers({
        'Content-Type': contentType || 'application/octet-stream',
        // 同じキーがあれば置き換える（再アップロードで詰まらせない）
        'x-upsert': 'true',
      }),
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // ⚠️ 本文をそのまま投げない。URL にキーが載っており、ログに流れる
      const hint = res.status === 400 || res.status === 404 ? '。バケット（SUPABASE_STORAGE_BUCKET）が作成済みか確認してください' : '';
      throw new Error(`ストレージへの保存に失敗しました (HTTP ${res.status})${hint}`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await fetch(this.objectUrl(key), {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (await isNotFound(res)) return null;
    if (!res.ok) throw new Error(`ストレージからの取得に失敗しました (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.objectUrl(key), {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 無いものを消すのは成功扱い（冪等）
    if (!res.ok && !(await isNotFound(res))) {
      throw new Error(`ストレージからの削除に失敗しました (HTTP ${res.status})`);
    }
  }

  async signedUrl(key: string, expiresInSec: number): Promise<string | null> {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${this.cfg.url}/storage/v1/object/sign/${this.cfg.bucket}/${encoded}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: expiresInSec }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { signedURL?: string };
    return body.signedURL ? `${this.cfg.url}/storage/v1${body.signedURL}` : null;
  }
}

export type { PutResult };
