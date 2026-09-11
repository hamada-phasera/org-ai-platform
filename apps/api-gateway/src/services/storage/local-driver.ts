// ローカルディスクの保存先。開発と、既存（移行前）ファイルの読み出しに使う。
//
// ⚠️ 本番では使わない。Render はデプロイのたびにファイルシステムを作り直すので、
//    ここに書いたものは次のデプロイで消える。本番の判定は driver.ts が行う。

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { StorageDriver } from './index';

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;

  constructor(private readonly base: string) {}

  /**
   * キーを実パスに直す。
   * ⚠️ base の外に出るキーを拒否する。`..` を含むキーでリポジトリの外を読ませない。
   * 既存行は絶対パスが入っているので、その場合だけ base 配下であることを確認して通す。
   */
  private pathFor(key: string): string {
    const full = isAbsolute(key) ? resolve(key) : resolve(join(this.base, key));
    const root = resolve(this.base);
    if (full !== root && !full.startsWith(`${root}/`)) {
      throw new Error('保存先として許可されていないパスです');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e) {
      // 実体が無いのは既知の状態（再デプロイで消えている）。例外にしない
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
    }
  }

  async signedUrl(): Promise<string | null> {
    // ローカルには期限つきの直リンクが作れない。API 経由で配る
    return null;
  }
}
