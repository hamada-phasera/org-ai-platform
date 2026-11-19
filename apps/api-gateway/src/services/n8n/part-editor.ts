// 運営向けの「n8n で開く」リンク（docs/design/canvas-home.md §8.4・§8.5）。部品 `part-<key>` のワークフローを
// n8n の public API で名前から引き、エディタの URL を返す。**読むだけ**（作る・変える・消すはしない＝T22）。
//
// ■ 呼ぶのは運営（isPlatformAdmin）にだけ。お客さんへの応答には n8n の URL もワークフロー ID も入れない（T19・T23）。
// ■ 5 分キャッシュ（見つからなかったことも覚える）。API キーが無い・n8n が未設定・失敗なら null（リンクを出さないだけ）。
// ⚠️ services/flows/ と routes/flows.ts から public API を直接触らないため、ここに分けている（architecture.test.ts）。

import { config } from '../../config/env';
import { createLogger } from '../../utils/logger';

const log = createLogger('flows');
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;
const PART_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

const cache = new Map<string, { url: string | null; at: number }>();

export function clearPartEditorCache(): void {
  cache.clear();
}

interface WorkflowList {
  data?: { id?: unknown; name?: unknown }[];
}

/** 部品のエディタの URL（`<n8n>/workflow/<id>`）。引けなければ null */
export async function partEditorUrl(key: string, now: number = Date.now()): Promise<string | null> {
  if (!PART_KEY_PATTERN.test(key) || !config.n8nConfigured || !config.n8nApiKey) return null;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.url;
  const n8nBase = config.n8nUrl.replace(/\/+$/, '');
  const name = `part-${key}`;
  let url: string | null = null;
  try {
    const res = await fetch(`${n8nBase}/api/v1/workflows?name=${encodeURIComponent(name)}&limit=10`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'X-N8N-API-KEY': config.n8nApiKey, accept: 'application/json' },
    });
    if (res.ok) {
      const body = (await res.json()) as WorkflowList;
      const wf = (body.data ?? []).find((w) => w.name === name && typeof w.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(w.id));
      url = wf ? `${n8nBase}/workflow/${wf.id as string}` : null;
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
  } catch (e) {
    log.warn(`部品のエディタ URL を引けませんでした part=${key}: ${e instanceof Error ? e.name : 'error'}`);
  }
  cache.set(key, { url, at: now });
  return url;
}
