/**
 * 業務フロー（docs/design/canvas-home.md §6）とホームキャンバスの配置（§6.6）の zod スキーマ。
 *
 * - すべて `.strict()`（知らないキー・知らない `type` は保存時に 400）。ノード型は許可リストの 7 種だけ（K3）。
 * - グラフと参照の検査は flows-core.ts の `checkFlowDefinition`（zod に依存しない＝web も同じ検査で印を付ける）。
 * - gateway が正（保存時・実行時に必ず通す）。web ではフロー画面の遅延チャンクからだけ読むこと（zod を初回ロードに載せない）。
 * - 部品のキーと入力の照合にはカタログが要るので、`buildFlowDefinitionSchema(parts)` で組み立てる。
 *   `flowDefinitionSchema` はチャンク 2 で部品カタログ（flow-parts.ts）に差し替えるまで空のカタログ＝部品ノードは全部拒否（安全側）。
 */
import { z } from 'zod';
import type { AgentDepartment } from './index';
import { PAGE_ICONS, hasControlChars, utf8ByteLength } from './pages-plan';
import { pageFieldSchema } from './pages';
import {
  CANVAS_LAYOUT_LIMITS as CL,
  FLOW_DEFINITION_LIMITS as L,
  FLOW_TEMPLATE_KEYS,
  isCanvasLinkPath,
} from './flows-plan';
import {
  FLOW_DATA_OPS,
  FLOW_DATA_RESOURCES,
  FLOW_DATA_RESOURCE_KEYS,
  FLOW_KEY_PATTERN,
  FLOW_NODE_ID_PATTERN,
  FLOW_PART_KEY_PATTERN,
  FLOW_RESERVED_KEYS,
  FLOW_RESERVED_NODE_IDS,
  checkFlowDefinition,
  parseRef,
  type FlowPartSpec,
} from './flows-core';

const CONTROL_MSG = '制御文字は使えません';

/** 1 行の文字（1 文字以上） */
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChars(v), CONTROL_MSG);

/** 式を埋め込める文字。`min` 0 なら空も可 */
const template = (max: number, opts: { multiline?: boolean; min?: number } = {}) =>
  z
    .string()
    .min(opts.min ?? 1)
    .max(max)
    .refine((v) => !hasControlChars(v, opts.multiline === true), CONTROL_MSG);

export const flowNodeIdSchema = z
  .string()
  .regex(FLOW_NODE_ID_PATTERN, 'ID は英小文字で始まる英小文字・数字・_（1〜24 文字）')
  .refine((v) => !FLOW_RESERVED_NODE_IDS.includes(v), 'その ID は使えません');

export const flowKeySchema = z
  .string()
  .regex(FLOW_KEY_PATTERN, 'key は英字で始まる英数字・_（1〜32 文字）')
  .refine((v) => !FLOW_RESERVED_KEYS.includes(v), 'その key は使えません');

export const flowPartKeySchema = z.string().regex(FLOW_PART_KEY_PATTERN, '部品のキーの形ではありません');

/** 値への参照（式 1 つだけ: `{{ node.key }}`） */
const refSchema = z
  .string()
  .max(80)
  .refine((v) => parseRef(v) !== null, '値の参照の形ではありません（{{ノード.キー}}）');

/**
 * 部署。⚠️ index.ts の AGENT_DEPARTMENTS を top-level で読まない（index → flows → index の循環で、ESM では
 * index の本体より先にここが評価され未初期化になる）。値はテストで AGENT_DEPARTMENTS と突き合わせる。
 */
export const FLOW_DEPARTMENTS = ['SALES', 'MARKETING', 'ACCOUNTING', 'ANALYTICS', 'GENERAL'] as const satisfies readonly AgentDepartment[];
const departmentSchema = z.enum(FLOW_DEPARTMENTS);
const minRoleSchema = z.enum(['MEMBER', 'ADMIN', 'OWNER']);

/** キーの数を数える record（z.record は件数を縛れないので refine） */
const keyedRecord = (value: z.ZodTypeAny, max: number) =>
  z
    .record(flowKeySchema, value)
    .refine((r) => Object.keys(r).length <= max, `項目は ${max} 個までです`);

// ── ノード（許可リスト 7 種。設計書 §6.2） ─────────────────────────

const nodeBase = { id: flowNodeIdSchema, label: line(L.labelMax) };

const triggerConfigSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('manual') }).strict(),
    z.object({ mode: z.literal('form'), fields: z.array(pageFieldSchema).min(1).max(L.formFieldsMax) }).strict(),
    z
      .object({
        mode: z.literal('schedule'),
        frequency: z.enum(['daily', 'weekly', 'monthly']),
        hourJst: z.number().int().min(0).max(23),
        dayOfWeek: z.number().int().min(0).max(6).optional(),
        /** 28 まで（どの月にもある日だけ。§14） */
        dayOfMonth: z.number().int().min(1).max(28).optional(),
      })
      .strict(),
  ])
  .superRefine((c, ctx) => {
    if (c.mode === 'form') {
      const keys = c.fields.map((f) => f.key);
      if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: '項目の key が重複しています' });
      keys.forEach((k, i) => {
        if (FLOW_RESERVED_KEYS.includes(k)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: 'その key は使えません' });
      });
      return;
    }
    if (c.mode !== 'schedule') return;
    if (c.frequency === 'weekly' && c.dayOfWeek === undefined) {
      ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: '曜日を選んでください' });
    }
    if (c.frequency === 'monthly' && c.dayOfMonth === undefined) {
      ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: '日を選んでください' });
    }
    if (c.frequency !== 'weekly' && c.dayOfWeek !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: '曜日は毎週のときだけ書けます' });
    }
    if (c.frequency !== 'monthly' && c.dayOfMonth !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: '日は毎月のときだけ書けます' });
    }
  });

const triggerNodeSchema = z.object({ ...nodeBase, type: z.literal('trigger'), config: triggerConfigSchema }).strict();

const aiConfigSchema = z
  .object({
    op: z.enum(['generate', 'summarize', 'extract', 'classify']),
    instruction: template(L.instructionMax, { multiline: true }),
    input: template(L.aiInputMax, { multiline: true, min: 0 }),
    fields: z
      .array(z.object({ key: flowKeySchema, label: line(L.labelMax), type: z.enum(['text', 'number', 'boolean']) }).strict())
      .min(1)
      .max(L.extractFieldsMax)
      .optional(),
    choices: z.array(line(L.choiceMax)).min(L.classifyChoicesMin).max(L.classifyChoicesMax).optional(),
    department: departmentSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op === 'extract') {
      if (!c.fields) ctx.addIssue({ code: 'custom', path: ['fields'], message: '取り出す項目が要ります' });
      else if (new Set(c.fields.map((f) => f.key)).size !== c.fields.length) {
        ctx.addIssue({ code: 'custom', path: ['fields'], message: '項目の key が重複しています' });
      }
    } else if (c.fields) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: '項目は「取り出す」のときだけ書けます' });
    }
    if (c.op === 'classify') {
      if (!c.choices) ctx.addIssue({ code: 'custom', path: ['choices'], message: '選択肢が要ります' });
      else if (new Set(c.choices).size !== c.choices.length) {
        ctx.addIssue({ code: 'custom', path: ['choices'], message: '選択肢が重複しています' });
      }
    } else if (c.choices) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: '選択肢は「分類」のときだけ書けます' });
    }
  });

const aiNodeSchema = z.object({ ...nodeBase, type: z.literal('ai'), config: aiConfigSchema }).strict();

const approvalNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal('approval'),
    config: z
      .object({
        message: template(L.approvalMessageMax),
        preview: template(L.approvalPreviewMax, { multiline: true }).optional(),
        minRole: minRoleSchema.optional(),
      })
      .strict(),
  })
  .strict();

const dataConfigSchema = z
  .object({
    resource: z.enum(FLOW_DATA_RESOURCE_KEYS),
    op: z.enum(FLOW_DATA_OPS),
    where: z
      .array(z.object({ field: flowKeySchema, value: template(L.branchRightMax, { min: 0 }) }).strict())
      .min(1)
      .max(L.dataWhereMax)
      .optional(),
    values: keyedRecord(template(L.dataValueMax, { multiline: true, min: 0 }), 20).optional(),
    limit: z.number().int().min(1).max(L.dataLimitMax).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const spec = FLOW_DATA_RESOURCES[c.resource];
    if (!spec.ops.includes(c.op)) {
      ctx.addIssue({ code: 'custom', path: ['op'], message: `この資源では ${c.op} はできません` });
      return;
    }
    (c.where ?? []).forEach((w, i) => {
      if (!spec.filterable.includes(w.field)) {
        ctx.addIssue({ code: 'custom', path: ['where', i, 'field'], message: `"${w.field}" では絞り込めません` });
      }
    });
    for (const k of Object.keys(c.values ?? {})) {
      if (!spec.writable.includes(k)) ctx.addIssue({ code: 'custom', path: ['values', k], message: `"${k}" は書けません` });
    }
    if (c.limit !== undefined && c.op !== 'list') {
      ctx.addIssue({ code: 'custom', path: ['limit'], message: '件数は一覧のときだけ書けます' });
    }
    switch (c.op) {
      case 'list':
        if (c.values) ctx.addIssue({ code: 'custom', path: ['values'], message: '一覧には値を書けません' });
        break;
      case 'get':
        if (!c.where) ctx.addIssue({ code: 'custom', path: ['where'], message: '条件が要ります' });
        if (c.values) ctx.addIssue({ code: 'custom', path: ['values'], message: '取得には値を書けません' });
        break;
      case 'create':
        if (c.where) ctx.addIssue({ code: 'custom', path: ['where'], message: '作成には条件を書けません' });
        for (const k of spec.required) {
          if (!c.values || !Object.prototype.hasOwnProperty.call(c.values, k) || c.values[k].trim() === '') {
            ctx.addIssue({ code: 'custom', path: ['values', k], message: `"${k}" は必須です` });
          }
        }
        break;
      case 'update':
        // 1 行だけ（id の等値）。一覧の条件で何行も書き換えない
        if (!c.where || c.where.length !== 1 || c.where[0].field !== 'id') {
          ctx.addIssue({ code: 'custom', path: ['where'], message: '更新は id の条件 1 つだけです' });
        }
        if (!c.values || Object.keys(c.values).length === 0) {
          ctx.addIssue({ code: 'custom', path: ['values'], message: '書き換える値が要ります' });
        }
        break;
      default:
        break;
    }
  });

const dataNodeSchema = z.object({ ...nodeBase, type: z.literal('data'), config: dataConfigSchema }).strict();

const partNodeSchema = z
  .object({
    ...nodeBase,
    type: z.literal('part'),
    config: z
      .object({ part: flowPartKeySchema, input: keyedRecord(template(L.partInputMax, { multiline: true, min: 0 }), 20) })
      .strict(),
  })
  .strict();

const branchConfigSchema = z
  .object({
    left: refSchema,
    op: z.enum(['eq', 'ne', 'gt', 'lt', 'contains', 'empty', 'not_empty']),
    right: z.union([line(L.branchRightMax), z.number().finite(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op === 'empty' || c.op === 'not_empty') {
      if (c.right !== undefined) ctx.addIssue({ code: 'custom', path: ['right'], message: '比べる値は要りません' });
    } else if (c.right === undefined) {
      ctx.addIssue({ code: 'custom', path: ['right'], message: '比べる値が要ります' });
    } else if ((c.op === 'gt' || c.op === 'lt') && typeof c.right !== 'number') {
      ctx.addIssue({ code: 'custom', path: ['right'], message: '大小は数で比べます' });
    } else if (c.op === 'contains' && typeof c.right !== 'string') {
      ctx.addIssue({ code: 'custom', path: ['right'], message: '「含む」は文字で比べます' });
    }
  });

const branchNodeSchema = z.object({ ...nodeBase, type: z.literal('branch'), config: branchConfigSchema }).strict();

const outputConfigSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('page'),
      values: keyedRecord(template(L.pageValueMax, { multiline: true, min: 0 }), L.pageValuesMax),
      rows: refSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('document'),
      title: template(L.documentTitleMax),
      body: template(L.documentBodyMax, { multiline: true }),
      department: departmentSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('notify'),
      channel: z.enum(['slack', 'email', 'line']),
      to: template(L.notifyToMax).optional(),
      body: template(L.notifyBodyMax, { multiline: true }),
    })
    .strict(),
]);

const outputNodeSchema = z.object({ ...nodeBase, type: z.literal('output'), config: outputConfigSchema }).strict();

export const flowNodeSchema = z.discriminatedUnion('type', [
  triggerNodeSchema,
  aiNodeSchema,
  approvalNodeSchema,
  dataNodeSchema,
  partNodeSchema,
  branchNodeSchema,
  outputNodeSchema,
]);

export const flowEdgeSchema = z
  .object({ from: flowNodeIdSchema, to: flowNodeIdSchema, when: z.enum(['yes', 'no']).optional() })
  .strict();

// ── 定義 ──────────────────────────────────────────────────

const baseFlowDefinitionSchema = z
  .object({
    nodes: z.array(flowNodeSchema).min(L.minNodes).max(L.maxNodes),
    edges: z.array(flowEdgeSchema).min(L.minEdges).max(L.maxEdges),
  })
  .strict();

export type FlowDefinition = z.infer<typeof baseFlowDefinitionSchema>;
export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type FlowNodeOf<T extends FlowNode['type']> = Extract<FlowNode, { type: T }>;

/** 部品カタログを渡してフロー定義のスキーマを作る（グラフ・参照・部品・承認の検査込み） */
export function buildFlowDefinitionSchema(parts: readonly FlowPartSpec[]) {
  return baseFlowDefinitionSchema.superRefine((def, ctx) => {
    if (utf8ByteLength(JSON.stringify(def)) > L.maxDefinitionBytes) {
      ctx.addIssue({ code: 'custom', path: [], message: `定義は ${L.maxDefinitionBytes / 1024}KB までです` });
    }
    for (const issue of checkFlowDefinition(def, parts)) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  });
}

/** チャンク 2 で部品カタログに差し替える。それまでは部品ノードを含む定義を拒否する */
export const flowDefinitionSchema = buildFlowDefinitionSchema([]);

// ── キャンバスの配置（設計書 §6.6） ─────────────────────────────

/** 座標は −5000〜5000 の整数に丸める */
const coordSchema = z
  .number()
  .finite()
  .transform((v) => Math.min(CL.coordMax, Math.max(CL.coordMin, Math.round(v))));

export const canvasFlowIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, 'フロー ID の形ではありません');

const canvasTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('flow'), flowId: canvasFlowIdSchema }).strict(),
  z.object({ kind: z.literal('template'), templateKey: z.enum(FLOW_TEMPLATE_KEYS) }).strict(),
  z
    .object({
      kind: z.literal('link'),
      to: z.string().max(80).refine((v) => isCanvasLinkPath(v), '開けない行き先です'),
    })
    .strict(),
]);

export const canvasNodeSchema = z
  .object({
    id: flowNodeIdSchema,
    label: line(CL.labelMax),
    icon: z.enum(PAGE_ICONS),
    x: coordSchema,
    y: coordSchema,
    target: canvasTargetSchema,
  })
  .strict();

const baseCanvasLayoutSchema = z
  .object({
    nodes: z.array(canvasNodeSchema).max(CL.maxNodes),
    edges: z.array(z.object({ from: flowNodeIdSchema, to: flowNodeIdSchema }).strict()).max(CL.maxEdges),
  })
  .strict();

/**
 * 線に意味は持たせない（v1）。自己ループと重複は拒否、循環は許す（業務の地図は循環しうる）。
 * `flowId` が自組織のフローかは gateway が保存時にテナントクライアントで確かめる。
 */
export const canvasLayoutSchema = baseCanvasLayoutSchema.superRefine((layout, ctx) => {
  if (utf8ByteLength(JSON.stringify(layout)) > CL.maxLayoutBytes) {
    ctx.addIssue({ code: 'custom', path: [], message: `配置は ${CL.maxLayoutBytes / 1024}KB までです` });
  }
  const ids = new Set<string>();
  layout.nodes.forEach((n, i) => {
    if (ids.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `ID "${n.id}" が重複しています` });
    ids.add(n.id);
  });
  const seen = new Set<string>();
  layout.edges.forEach((e, i) => {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      ctx.addIssue({ code: 'custom', path: ['edges', i], message: '線の端のノードがありません' });
    } else if (e.from === e.to) {
      ctx.addIssue({ code: 'custom', path: ['edges', i], message: '自分に戻る線は引けません' });
    }
    const k = `${e.from}\u0000${e.to}`;
    if (seen.has(k)) ctx.addIssue({ code: 'custom', path: ['edges', i], message: '同じ線が重複しています' });
    seen.add(k);
  });
});

export type CanvasLayout = z.output<typeof baseCanvasLayoutSchema>;
export type CanvasNode = z.output<typeof canvasNodeSchema>;
export type CanvasTarget = z.infer<typeof canvasTargetSchema>;
