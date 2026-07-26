/**
 * 埋め込みベクトル生成サービス（RAG 用）。
 *
 * Anthropic には埋め込み API が無いため、外部プロバイダを使う。
 *   - `gemini` (既定): `gemini-embedding-001`。`outputDimensionality` で 1024 を指定できるため
 *     LLM 用の GEMINI_API_KEY をそのまま流用でき、新たな契約が要らない。
 *   - `voyage` / `openai`: 従来通り利用可能（EMBEDDING_PROVIDER で切り替え）。
 * - API キーが未設定なら常に null を返す → RAG は静かに無効化され、チャットは従来通り動く。
 * - 出力次元は 1024 に固定（DB の vector(1024) と一致）。
 *   Gemini は outputDimensionality=1024、Voyage `voyage-3` は native 1024、
 *   OpenAI `text-embedding-3-small` は dimensions=1024 で揃えられる。
 */

const PROVIDER = (process.env.EMBEDDING_PROVIDER ?? 'gemini').toLowerCase();
// gemini を使う場合は LLM 用の GEMINI_API_KEY を流用できる（EMBEDDING_API_KEY が優先）。
const API_KEY =
  process.env.EMBEDDING_API_KEY || (PROVIDER === 'gemini' ? process.env.GEMINI_API_KEY ?? '' : '');
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

const VOYAGE_MODEL = process.env.EMBEDDING_MODEL ?? 'voyage-3';
const OPENAI_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
const GEMINI_MODEL = process.env.EMBEDDING_MODEL ?? 'gemini-embedding-001';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export function isEmbeddingEnabled(): boolean {
  return API_KEY.length > 0;
}

type EmbeddingResp = { data?: Array<{ index: number; embedding: number[] }> };
/** Gemini batchEmbedContents の応答。data[].index を持たず、要求順で返る。 */
type GeminiEmbeddingResp = { embeddings?: Array<{ values?: number[] }> };

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

  // Gemini は認証ヘッダ・リクエスト形・応答形がいずれも OpenAI 互換ではないため分岐する。
  const isGemini = PROVIDER === 'gemini';
  const url = isGemini
    ? `${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:batchEmbedContents`
    : PROVIDER === 'openai'
      ? 'https://api.openai.com/v1/embeddings'
      : 'https://api.voyageai.com/v1/embeddings';

  const payload = isGemini
    ? {
        requests: cleaned.map((text) => ({
          model: `models/${GEMINI_MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIM,
          // 検索クエリと文書を区別すると精度が上がる（voyage の input_type 相当）。
          taskType: inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
        })),
      }
    : PROVIDER === 'openai'
      ? { model: OPENAI_MODEL, input: cleaned, dimensions: EMBEDDING_DIM }
      : { model: VOYAGE_MODEL, input: cleaned, input_type: inputType };

  const headers: Record<string, string> = isGemini
    ? { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` };

  // レート制限(429)・一時的な5xxは指数バックオフで数回リトライ（埋め込みプロバイダの無料枠は 429 を返しやすい）
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        if (isGemini) {
          const json = (await res.json()) as GeminiEmbeddingResp;
          return validateGemini(json.embeddings, cleaned.length);
        }
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

/**
 * Gemini の応答を検証する。index を持たず要求順で返るため並べ替えはせず、
 * 件数と次元数だけを確認する（1 件でも欠けたら全体を null にして RAG を無効化＝捏造を防ぐ）。
 */
function validateGemini(
  embeddings: Array<{ values?: number[] }> | undefined,
  expectedCount: number,
): number[][] | null {
  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) return null;
  const out = embeddings.map((e) => e.values);
  if (out.some((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIM)) return null;
  return out as number[][];
}
