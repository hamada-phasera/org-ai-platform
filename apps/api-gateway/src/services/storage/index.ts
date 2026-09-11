// ファイルの保存先。ローカルディスクと Supabase Storage を同じ形で扱う。
//
// ⚠️ Render の web サービスはデプロイのたびにファイルシステムが作り直される
//    （render.yaml に disk の宣言が無い）。本番でローカルに書くと、
//    UploadedFile の行だけが残って実体が消える（2026-09-11 時点で本番の行は 0 件だったので実害は無し）。
//
// SDK（@supabase/supabase-js）は入れない。使うのは object の PUT / GET / DELETE と
// 署名URLの4本だけで、そのために依存を1つ増やす価値がない
// （LINE クライアントを SDK 無しで書いているのと同じ方針）。

export type StorageDriverName = 'local' | 'supabase';

export interface PutResult {
  /** driver ごとのキー。DB の UploadedFile.storagePath に入る */
  key: string;
  driver: StorageDriverName;
}

export interface StorageDriver {
  readonly name: StorageDriverName;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** 実体が無ければ null を返す。**例外にしない**（消えているのは異常ではなく既知の状態） */
  get(key: string): Promise<Buffer | null>;
  /** 冪等。無いものを消しても成功扱い */
  delete(key: string): Promise<void>;
  /** 期限つきの直リンク。local では作れないので null */
  signedUrl(key: string, expiresInSec: number): Promise<string | null>;
}

/**
 * 組織ごとに区切ったキー。
 * ⚠️ orgId を必ず先頭に置く。ここが混ざると他組織のファイルを引ける。
 * ⚠️ 名前は安全な文字だけに落とす（パストラバーサルとキー衝突の両方を防ぐ）。
 */
export function storageKey(orgId: string, fileId: string, originalName: string): string {
  const safe = originalName
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .slice(0, 100);
  return `${orgId}/${fileId}_${safe || 'file'}`;
}

/** そのキーが指定した組織のものか。取得・削除の前に必ず確認する。 */
export function keyBelongsToOrg(key: string, orgId: string): boolean {
  return key.startsWith(`${orgId}/`);
}
