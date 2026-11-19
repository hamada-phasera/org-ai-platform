// ノード型ごとの実行の共通の形（docs/design/canvas-home.md §7.1）。1 型 1 ファイル。
import type { FlowNode, FlowScope } from '@org-ai/shared-types';
import type { TenantDb } from '../../../tenancy/tenant-db';

export interface NodeRunContext {
  db: TenantDb;
  run: { id: string; orgId: string; actorId: string | null; input: Record<string, unknown> };
  plan: string;
  scope: FlowScope;
  node: FlowNode;
  /**
   * 外へ送るノードで、人が承認したときに見せた中身（展開済みの値。K57）。あればこれをそのまま送る
   * （承認の後に組み直さない＝人が見たものと送るものをずらさない）。
   */
  gateArgs?: Record<string, string>;
}

export type NodeResult =
  | { ok: true; output: Record<string, unknown>; warnings?: string[]; truncated?: boolean; aiCalls?: number; partCalls?: number; attempts?: number }
  | { ok: false; error: { code: string; message: string }; aiCalls?: number; partCalls?: number; attempts?: number };

export const fail = (code: string, message: string, extra: { aiCalls?: number; partCalls?: number; attempts?: number } = {}): NodeResult => ({
  ok: false,
  error: { code, message },
  ...extra,
});

/** 項目をまとめて展開し、warnings と truncated を集める */
export class Renderer {
  warnings: string[] = [];
  truncated = false;
  constructor(
    private readonly scope: FlowScope,
    private readonly render: (t: string, s: FlowScope) => { text: string; warnings: string[]; truncated: boolean },
  ) {}
  text(template: string | undefined): string {
    if (template === undefined) return '';
    const r = this.render(template, this.scope);
    this.warnings.push(...r.warnings);
    if (r.truncated) this.truncated = true;
    return r.text;
  }
}

const MAX_ROWS = 50;

/** 表の行をスカラーだけに切り詰める（オブジェクト・配列の値は捨てる） */
export function scalarRows(value: unknown): Record<string, string | number | boolean | null>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_ROWS).flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'boolean' || v === null) out[k] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return [out];
  });
}
