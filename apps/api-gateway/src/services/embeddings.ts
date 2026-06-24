/**
 * 埋め込みベクトル生成サービス（RAG 用）。
 *
 * Anthropic には埋め込み API が無いため、外部プロバイダ（Voyage AI 推奨 / OpenAI 代替）を使う。
 * - EMBEDDING_API_KEY が未設定なら常に null を返す → RAG 機能は静かに無効化され、チャットは従来通り動く。
 * - 出力次元は 1024 に固定（DB の vector(1024) と一致）。
 *   Voyage `voyage-3` は native 1024、OpenAI `text-embedding-3-small` は dimensions=1024 で 1024 を出力できる。
 */

const PROVIDER = (process.env.EMBEDDING_PROVIDER ?? 'voyage').toLowerCase();
const API_KEY = process.env.EMBEDDING_API_KEY ?? '';
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

const VOYAGE_MODEL = process.env.EMBEDDING_MODEL ?? 'voyage-3';
const OPENAI_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';

export function isEmbeddingEnabled(): boolean {
  return API_KEY.length > 0;
}

type EmbeddingResp = { data?: Array<{ index: number; embedding: number[] }> };

/**
 * 複数テキストをまとめて埋め込む。失敗時 / 無効時は null。
 * @param inputType voyage の input_type ('query' | 'document')。検索クエリと文書を区別すると精度が上がる。
 */
export async function embedTexts(
  texts: string[],
  inputType: 'query' | 'document' = 'document',
): Promise<number[][] | null> {
  if (!isEmbeddingEnabled() || texts.length === 0) return null;
  const cleaned = texts.map((t) => t.trim().slice(0, 8000)).filter((t) => t.length > 0);
  if (cleaned.length === 0) return null;

  const url = PROVIDER === 'openai' ? 'https://api.openai.com/v1/embeddings' : 'https://api.voyageai.com/v1/embeddings';
  const payload =
    PROVIDER === 'openai'
      ? { model: OPENAI_MODEL, input: cleaned, dimensions: EMBEDDING_DIM }
      : { model: VOYAGE_MODEL, input: cleaned, input_type: inputType };

  // レート制限(429)・一時的な5xxは指数バックオフで数回リトライ（埋め込みプロバイダの無料枠は 429 を返しやすい）
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const json = (await res.json()) as EmbeddingResp;
        return orderAndValidate(json.data, cleaned.length);
      }
      // リトライ対象でなければ即終了
      if (res.status !== 429 && res.status < 500) return null;
    } catch {
      // ネットワーク/タイムアウト → リトライ
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      const backoffMs = 800 * Math.pow(2, attempt); // 0.8s, 1.6s, 3.2s
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  return null;
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const out = await embedTexts([text], 'query');
  return out?.[0] ?? null;
}

function orderAndValidate(
  data: Array<{ index: number; embedding: number[] }> | undefined,
  expectedCount: number,
): number[][] | null {
  if (!Array.isArray(data) || data.length !== expectedCount) return null;
  const sorted = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (sorted.some((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIM)) return null;
  return sorted;
}
