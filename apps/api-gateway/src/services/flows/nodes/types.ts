// ノード型ごとの実行の共通の形（docs/design/canvas-home.md §7.1）。1 型 1 ファイル。
import type { FlowNode, FlowScope } from '@org-ai/shared-types';
import type { TenantDb } from '../../../tenancy/tenant-db';

export interface NodeRunContext {
  db: TenantDb;
  run: { id: string; orgId: string; actorId: string | null; input: Record<string, unknown> };
  plan: string;
  scope: FlowScope;
  node: FlowNode;
}

export type NodeResult =
  | { ok: true; output: Record<string, unknown>; warnings?: string[]; truncated?: boolean; aiCalls?: number; attempts?: number }
  | { ok: false; error: { code: string; message: string }; aiCalls?: number; attempts?: number };

export const fail = (code: string, message: string, extra: { aiCalls?: number; attempts?: number } = {}): NodeResult => ({
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
