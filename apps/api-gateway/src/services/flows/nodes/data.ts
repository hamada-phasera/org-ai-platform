// データ: 許可リストの資源を tenantDb で読み書きする（§6.5）。読み取り（list / get）だけ 1 回やり直し、5 秒で打ち切る。
// 書き込み（create / update）は打ち切らない: Promise.race では DB の書き込みは止まらず、遅れて成功したのに FAILED と出て
// 「もう一度実行」で二重に作られるため（レビュー指摘 7）。書き込みの上限は実行全体のタイムアウトと DB 側に任せる。
import { FLOW_RUN_LIMITS, renderTemplate } from '@org-ai/shared-types';
import { DataNodeError, runDataRequest } from '../data-resources';
import { Renderer, fail, type NodeResult, type NodeRunContext } from './types';
import { createLogger, errorMessage } from '../../../utils/logger';

const log = createLogger('flows');

/** 調整値（テストで差し替える） */
export const dataNodeTuning = { readTimeoutMs: FLOW_RUN_LIMITS.dataNodeTimeoutMs as number };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DataNodeError('TIMEOUT', 'データの読み書きが時間内に終わりませんでした')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function runDataNode(ctx: NodeRunContext): Promise<NodeResult> {
  if (ctx.node.type !== 'data') return fail('FLOW_NODE_TYPE', '型が違います');
  const c = ctx.node.config;
  const r = new Renderer(ctx.scope, renderTemplate);
  const where = (c.where ?? []).map((w) => ({ field: w.field, value: r.text(w.value) }));
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.values ?? {})) values[k] = r.text(v);
  const readOnly = c.op === 'list' || c.op === 'get';
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const request = runDataRequest(ctx.db, { resource: c.resource, op: c.op, where, values, limit: c.limit ?? 20, actorId: ctx.run.actorId });
      const output = readOnly ? await withTimeout(request, dataNodeTuning.readTimeoutMs) : await request;
      return { ok: true, output, warnings: r.warnings, truncated: r.truncated, attempts };
    } catch (e) {
      if (e instanceof DataNodeError) {
        if (e.code === 'TIMEOUT' && readOnly && attempts < 2) continue;
        return fail(e.code, e.message, { attempts });
      }
      log.warn(`データノードの失敗 runId=${ctx.run.id} nodeId=${ctx.node.id}: ${String(errorMessage(e))}`);
      if (readOnly && attempts < 2) continue;
      return fail('FLOW_DATA_FAILED', 'データの読み書きに失敗しました', { attempts });
    }
  }
}
