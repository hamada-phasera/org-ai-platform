import { readFile } from 'fs/promises';

const MAX_EXTRACT_CHARS = 20000;

// 任意インストール依存を型エラーなく動的 import するためのヘルパー
// (pdf-parse / mammoth は optional dependency で、未インストールでもビルドできるようにする)
const optionalImport = (name: string): Promise<any> =>
  (new Function('m', 'return import(m)')(name) as Promise<any>).catch(() => null);

export interface ExtractResult {
  text: string;
  truncated: boolean;
  extractor: 'text' | 'pdf' | 'docx' | 'unsupported';
}

export interface ExtractOptions {
  /** 抽出する最大文字数。RAG インデックス用に大きな値を渡せる。既定 20,000。 */
  maxChars?: number;
}

/**
 * テキストを抽出する。
 *
 * source はファイルパスでもバッファでもよい。
 * ⚠️ 保存先がオブジェクトストレージになるとローカルパスが存在しないので、
 *    バッファを直接受けられないと RAG の索引づくりと解析が両方壊れる。
 *    パスを渡す既存の呼び出しはそのまま動く。
 */
export async function extractText(
  source: string | Buffer,
  mimeType: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const maxChars = options.maxChars ?? MAX_EXTRACT_CHARS;
  const load = async (): Promise<Buffer> => (typeof source === 'string' ? readFile(source) : source);

  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    const buf = await load();
    const text = buf.toString('utf-8');
    return trim(text, 'text', maxChars);
  }

  if (mimeType === 'application/pdf') {
    try {
      const mod = await optionalImport('pdf-parse');
      if (!mod) return unsupported('pdf-parse がインストールされていません (npm i pdf-parse)');
      const parser = mod.default ?? mod;
      const buf = await load();
      const out = await parser(buf);
      return trim(String(out.text ?? ''), 'pdf', maxChars);
    } catch (e) {
      return unsupported(`PDF抽出に失敗しました: ${(e as Error).message}`);
    }
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const mod = await optionalImport('mammoth');
      if (!mod) return unsupported('mammoth がインストールされていません (npm i mammoth)');
      const out = await mod.extractRawText(
        typeof source === 'string' ? { path: source } : { buffer: source },
      );
      return trim(String(out.value ?? ''), 'docx', maxChars);
    } catch (e) {
      return unsupported(`DOCX抽出に失敗しました: ${(e as Error).message}`);
    }
  }

  return unsupported(`このMIMEタイプ(${mimeType})からのテキスト抽出は未対応です`);
}

function trim(text: string, extractor: ExtractResult['extractor'], maxChars: number): ExtractResult {
  const truncated = text.length > maxChars;
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
    extractor,
  };
}

function unsupported(message: string): ExtractResult {
  return { text: message, truncated: false, extractor: 'unsupported' };
}
