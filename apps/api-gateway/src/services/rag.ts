/**
 * RAG（Retrieval-Augmented Generation）サービス。
 *
 * - ファイルアップロード時にテキストを抽出・チャンク分割・埋め込みして FileChunk に保存。
 * - チャットメッセージ保存時に埋め込みして MessageEmbedding に保存（過去履歴の横断参照用）。
 * - チャット送信時にユーザー入力を埋め込み、関連するファイルチャンク／過去メッセージを
 *   pgvector のコサイン類似度で取得し、根拠ブロックを組み立てる。
 *
 * 埋め込みが無効（EMBEDDING_API_KEY 未設定）なら全関数が安全に no-op / null を返す。
 * vector 列は Prisma 非対応のため、読み書きはすべて $queryRaw / $executeRaw。
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { extractText } from '../utils/fileExtractor';
import { embedTexts, embedQuery, isEmbeddingEnabled, EMBEDDING_DIM } from './embeddings';

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const MAX_INDEX_CHARS = 200_000; // 1 ファイルあたりインデックス対象の上限
const MAX_CHUNKS = 400;

/** テキストをオーバーラップ付きでチャンク分割する。 */
function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(i + CHUNK_SIZE, clean.length);
    const piece = clean.slice(i, end).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= clean.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/** number[] を pgvector のリテラル文字列 "[a,b,c]" に変換。 */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/**
 * ファイルを抽出→チャンク→埋め込み→FileChunk へ保存（既存チャンクは置き換え）。
 * アップロード応答をブロックしないよう fire-and-forget で呼ぶこと（await しない）。
 */
export async function indexFile(
  fileId: string,
  orgId: string,
  storagePath: string,
  mimeType: string,
): Promise<void> {
  if (!isEmbeddingEnabled()) return;
  const extracted = await extractText(storagePath, mimeType, { maxChars: MAX_INDEX_CHARS });
  if (extracted.extractor === 'unsupported' || !extracted.text.trim()) return;

  const chunks = chunkText(extracted.text);
  if (chunks.length === 0) return;

  const vectors = await embedTexts(chunks, 'document');
  if (!vectors || vectors.length !== chunks.length) return;

  // 再アップロード等での重複を避けるため、このファイルの既存チャンクを削除してから入れ直す
  await prisma.$executeRaw`DELETE FROM "FileChunk" WHERE "fileId" = ${fileId}`;

  for (let idx = 0; idx < chunks.length; idx++) {
    const vec = vectors[idx];
    if (vec.length !== EMBEDDING_DIM) continue;
    await prisma.$executeRaw`
      INSERT INTO "FileChunk" ("id", "orgId", "fileId", "chunkIndex", "content", "embedding")
      VALUES (${randomUUID()}, ${orgId}, ${fileId}, ${idx}, ${chunks[idx]}, ${toVectorLiteral(vec)}::vector)
    `;
  }
}

/** チャットメッセージを埋め込み→MessageEmbedding へ保存。fire-and-forget 推奨。 */
export async function indexMessage(
  messageId: string,
  orgId: string,
  sessionId: string,
  role: string,
  content: string,
): Promise<void> {
  if (!isEmbeddingEnabled()) return;
  const text = content.trim();
  if (text.length < 12) return; // ごく短い相槌は索引しない

  const vectors = await embedTexts([text.slice(0, 8000)], 'document');
  const vec = vectors?.[0];
  if (!vec || vec.length !== EMBEDDING_DIM) return;

  await prisma.$executeRaw`
    INSERT INTO "MessageEmbedding" ("id", "orgId", "messageId", "sessionId", "role", "content", "embedding")
    VALUES (${randomUUID()}, ${orgId}, ${messageId}, ${sessionId}, ${role}, ${text.slice(0, 8000)}, ${toVectorLiteral(vec)}::vector)
    ON CONFLICT ("messageId") DO NOTHING
  `;
}

export interface RetrievedContext {
  block: string;
  fileSources: string[];
  chatMatches: number;
}

/**
 * ユーザー入力に関連するファイルチャンク／過去メッセージを取得し、根拠ブロックを組み立てる。
 * 関連が無い / 無効なら null（→ グラウンディングしない）。
 */
export async function retrieveContext(opts: {
  orgId: string;
  query: string;
  fileIds?: string[];
  excludeSessionId?: string;
}): Promise<RetrievedContext | null> {
  if (!isEmbeddingEnabled() || !opts.query.trim()) return null;

  const qvec = await embedQuery(opts.query);
  if (!qvec || qvec.length !== EMBEDDING_DIM) return null;
  const qlit = toVectorLiteral(qvec);

  const fileFilter =
    opts.fileIds && opts.fileIds.length > 0
      ? Prisma.sql`AND fc."fileId" IN (${Prisma.join(opts.fileIds)})`
      : Prisma.empty;

  const fileRows = await prisma.$queryRaw<Array<{ content: string; fileId: string; score: number }>>(Prisma.sql`
    SELECT fc."content", fc."fileId", 1 - (fc."embedding" <=> ${qlit}::vector) AS score
    FROM "FileChunk" fc
    WHERE fc."orgId" = ${opts.orgId} AND fc."embedding" IS NOT NULL ${fileFilter}
    ORDER BY fc."embedding" <=> ${qlit}::vector
    LIMIT 6
  `);

  const sessionFilter = opts.excludeSessionId
    ? Prisma.sql`AND me."sessionId" <> ${opts.excludeSessionId}`
    : Prisma.empty;

  const msgRows = await prisma.$queryRaw<Array<{ content: string; role: string; score: number }>>(Prisma.sql`
    SELECT me."content", me."role", 1 - (me."embedding" <=> ${qlit}::vector) AS score
    FROM "MessageEmbedding" me
    WHERE me."orgId" = ${opts.orgId} AND me."embedding" IS NOT NULL ${sessionFilter}
    ORDER BY me."embedding" <=> ${qlit}::vector
    LIMIT 4
  `);

  // 明示的に添付されたファイルは類似度に関わらず必ず含める。
  // （off-topic な質問でも「資料には記載がありません」と正しく答えられる＝ファイルが見えていない誤応答を防ぐ）
  // 横断検索（添付なし）のしきい値は控えめ（0.3）。Voyage の日本語コサインは関連でも 0.3〜0.5 に収まりやすく、
  // GROUNDING_INSTRUCTION が「資料に無い事は記載なしと言う」を担保するため、再現率を優先して取りこぼしを防ぐ。
  const hasExplicitFiles = !!(opts.fileIds && opts.fileIds.length > 0);
  const FILE_MIN = 0.3;
  const MSG_MIN = 0.3;
  const files = hasExplicitFiles ? fileRows : fileRows.filter((r) => Number(r.score) >= FILE_MIN);
  const msgs = msgRows.filter((r) => Number(r.score) >= MSG_MIN);
  if (files.length === 0 && msgs.length === 0) return null;

  const fileIds = [...new Set(files.map((f) => f.fileId))];
  const fileMeta = fileIds.length
    ? await prisma.uploadedFile.findMany({
        where: { id: { in: fileIds }, orgId: opts.orgId },
        select: { id: true, originalName: true },
      })
    : [];
  const nameOf = (id: string) => fileMeta.find((f) => f.id === id)?.originalName ?? 'ファイル';

  let budget = 6000;
  const parts: string[] = [];
  const fileSources = new Set<string>();

  if (files.length > 0) {
    parts.push('## 参考資料（アップロードされたファイル）');
    for (const f of files) {
      const piece = f.content.slice(0, 1200);
      if (budget - piece.length < 0) break;
      budget -= piece.length;
      parts.push(`【出典: ${nameOf(f.fileId)}】\n${piece}`);
      fileSources.add(nameOf(f.fileId));
    }
  }

  let chatMatches = 0;
  if (msgs.length > 0 && budget > 600) {
    parts.push('\n## 過去のやり取り（別セッション含む）');
    for (const m of msgs) {
      const piece = m.content.slice(0, 600);
      if (budget - piece.length < 0) break;
      budget -= piece.length;
      parts.push(`（${m.role === 'user' ? '社長' : 'AI'}）${piece}`);
      chatMatches++;
    }
  }

  return { block: parts.join('\n'), fileSources: [...fileSources], chatMatches };
}
