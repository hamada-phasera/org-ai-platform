// Google Docs / Sheets / Slides REST の薄いクライアント（googleapis SDK 不使用）。
// line-client.ts 流儀: fetch + AbortSignal.timeout、throw せず戻り値。
// スコープは drive.file（このアプリが作成したファイルのみ）で全操作が通る。
// ⚠️ ログ・戻り値の message に accessToken を絶対に含めないこと。

const API_TIMEOUT_MS = 15_000;

export type GoogleApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; authDead: boolean };

async function googleFetch<T>(
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<GoogleApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (res.ok) {
      return { ok: true, data: (await res.json()) as T };
    }
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      // トークンは URL にもヘッダにも body にも含まれないが、念のため先頭 200 文字に切る
      message: `Google API ${res.status}: ${body.slice(0, 200)}`,
      authDead: res.status === 401,
    };
  } catch (e) {
    const isTimeout = (e as { name?: string })?.name === 'TimeoutError' || /timeout|abort/i.test(String(e));
    return { ok: false, status: 0, message: isTimeout ? 'timeout' : String(e), authDead: false };
  }
}

// ── Docs ──────────────────────────────────────────────────────────

export type CreatedDoc = { documentId: string; url: string };

export async function createDoc(
  accessToken: string,
  title: string,
  content: string,
): Promise<GoogleApiResult<CreatedDoc>> {
  const created = await googleFetch<{ documentId?: string }>(
    'https://docs.googleapis.com/v1/documents',
    accessToken,
    { method: 'POST', body: JSON.stringify({ title }) },
  );
  if (!created.ok) return created;
  const documentId = created.data.documentId;
  if (!documentId) return { ok: false, status: 500, message: 'documentId が返りませんでした', authDead: false };

  if (content.trim()) {
    const inserted = await googleFetch(
      `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: 1 }, text: content } }],
        }),
      },
    );
    if (!inserted.ok) return inserted;
  }
  return { ok: true, data: { documentId, url: `https://docs.google.com/document/d/${documentId}/edit` } };
}

// ── Sheets ────────────────────────────────────────────────────────

export type CreatedSheet = { spreadsheetId: string; url: string };

export async function createSheet(
  accessToken: string,
  title: string,
  headers: string[],
  rows: string[][],
): Promise<GoogleApiResult<CreatedSheet>> {
  const created = await googleFetch<{ spreadsheetId?: string; spreadsheetUrl?: string }>(
    'https://sheets.googleapis.com/v4/spreadsheets',
    accessToken,
    { method: 'POST', body: JSON.stringify({ properties: { title } }) },
  );
  if (!created.ok) return created;
  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) return { ok: false, status: 500, message: 'spreadsheetId が返りませんでした', authDead: false };

  const values = [headers, ...rows];
  if (values.some((r) => r.length > 0)) {
    const wrote = await googleFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1?valueInputOption=RAW`,
      accessToken,
      { method: 'PUT', body: JSON.stringify({ values }) },
    );
    if (!wrote.ok) return wrote;
  }
  return {
    ok: true,
    data: {
      spreadsheetId,
      url: created.data.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    },
  };
}

// ── Slides ────────────────────────────────────────────────────────

export interface SlideInput {
  title?: string;
  content?: string;
}

/**
 * batchUpdate のリクエスト配列を組み立てる pure 関数（テスト対象）。
 * 各スライドを TITLE_AND_BODY レイアウトで作成し、placeholderIdMappings で
 * 決定的な objectId（slide_{i}_title / slide_{i}_body）を採番して insertText する。
 */
export function buildSlidesRequests(slides: SlideInput[]): unknown[] {
  const requests: unknown[] = [];
  slides.forEach((slide, i) => {
    requests.push({
      createSlide: {
        objectId: `slide_${i}`,
        slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'TITLE' }, objectId: `slide_${i}_title` },
          { layoutPlaceholder: { type: 'BODY' }, objectId: `slide_${i}_body` },
        ],
      },
    });
    if (slide.title) {
      requests.push({ insertText: { objectId: `slide_${i}_title`, text: slide.title } });
    }
    if (slide.content) {
      requests.push({ insertText: { objectId: `slide_${i}_body`, text: slide.content } });
    }
  });
  return requests;
}

export type CreatedSlides = { presentationId: string; url: string };

export async function createSlides(
  accessToken: string,
  title: string,
  slides: SlideInput[],
): Promise<GoogleApiResult<CreatedSlides>> {
  const created = await googleFetch<{ presentationId?: string }>(
    'https://slides.googleapis.com/v1/presentations',
    accessToken,
    { method: 'POST', body: JSON.stringify({ title }) },
  );
  if (!created.ok) return created;
  const presentationId = created.data.presentationId;
  if (!presentationId) return { ok: false, status: 500, message: 'presentationId が返りませんでした', authDead: false };

  const requests = buildSlidesRequests(slides);
  if (requests.length > 0) {
    const updated = await googleFetch(
      `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
      accessToken,
      { method: 'POST', body: JSON.stringify({ requests }) },
    );
    // Slides の batchUpdate は placeholder の癖で失敗しうる。プレゼン自体は作成済みなので
    // 本文挿入の失敗は「空のプレゼン + エラー」ではなく URL 付き成功に倒さない（呼び出し側で NODE_FAILED）。
    if (!updated.ok) return updated;
  }
  return {
    ok: true,
    data: { presentationId, url: `https://docs.google.com/presentation/d/${presentationId}/edit` },
  };
}
