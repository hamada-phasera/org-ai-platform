/**
 * 業務フロー（docs/design/canvas-home.md §6）の純粋関数。zod に依存しない。
 *
 * - 並び（`topoOrder`）・上流（`upstreamOf`）・出力キー（`outputKeysOf`）・式の展開（`renderTemplate`）と、
 *   グラフの検査（`checkFlowDefinition`。flows.ts の superRefine が呼ぶ）を置く。
 * - gateway（検証・実行順・展開）と web（差し込みの候補・スマホの番号・入力中のエラー）で共用する。
 * ⚠️ ここに zod を import しない（スマホの縦リストが読む。flows-plan.ts と同じ理由）。型は `import type` だけ。
 * ⚠️ `eval` / `new Function` / テンプレートエンジンは使わない（設計書 K13・T2。ソーステストで固定）。
 */
import type { Plan } from './index';
import type { PageField, PageIcon } from './index';
import type { FlowDefinition, FlowNode } from './flows';
import { hasControlChars, utf8ByteLength } from './pages-plan';
import { FLOW_DEFINITION_LIMITS as L } from './flows-plan';

// ── 名前の形 ─────────────────────────────────────────────

/** ノード ID: 英小文字で始まる英小文字・数字・_（1〜24 文字） */
export const FLOW_NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
/** 出力・入力のキー: 英字で始まる英数字・_（1〜32 文字）。業務ページの key と同じ */
export const FLOW_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
/** 部品のキー（設計書 §5.7）。n8n の Webhook パスは gateway が `parts/<key>` に組み立てる */
export const FLOW_PART_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
/** フローの slug（業務ページと同じ形） */
export const FLOW_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** 組み込みの参照（`{{ run.date }}` `{{ run.id }}` `{{ org.name }}`）。ノード ID には使えない */
export const FLOW_BUILTIN_REFS: Readonly<Record<string, readonly string[]>> = {
  run: ['date', 'id'],
  org: ['name'],
};

/**
 * ノード ID に使えない名前。組み込み（run / org）と、オブジェクトの組み込みのプロパティ名
 * （正規表現を通ってしまう英小文字だけのもの）。`__proto__` は正規表現で弾かれる。
 */
export const FLOW_RESERVED_NODE_IDS: readonly string[] = ['run', 'org', 'constructor', 'prototype'];

/** キーに使えない名前（プロトタイプ汚染・組み込みの取り違え。設計書 T3） */
export const FLOW_RESERVED_KEYS: readonly string[] = [
  'constructor',
  'prototype',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toString',
  'toLocaleString',
  'valueOf',
];

export function isFlowNodeId(value: unknown): value is string {
  return typeof value === 'string' && FLOW_NODE_ID_PATTERN.test(value) && !FLOW_RESERVED_NODE_IDS.includes(value);
}

export function isFlowKey(value: unknown): value is string {
  return typeof value === 'string' && FLOW_KEY_PATTERN.test(value) && !FLOW_RESERVED_KEYS.includes(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ── テンプレート式（設計書 §6.4。パス参照だけ・展開 1 回） ──────────────────────

/** 式 1 つ。`{{ nodeId.key }}`。関数・演算・条件・入れ子・フィルタは無い */
const EXPR_SOURCE = '\\{\\{\\s*([a-z][a-z0-9_]{0,23})\\.([a-zA-Z][a-zA-Z0-9_]{0,31})\\s*\\}\\}';
/** 値そのものを渡す参照（分岐の `left`・`rows`）。式 1 つだけの文字列 */
const REF_PATTERN = new RegExp(`^${EXPR_SOURCE}$`);

export interface FlowTemplateRef {
  node: string;
  key: string;
}

/** 文字列の中の式を順に取り出す（同じ参照が何度出ても全部返す） */
export function parseTemplateRefs(template: string): FlowTemplateRef[] {
  const out: FlowTemplateRef[] = [];
  const re = new RegExp(EXPR_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) out.push({ node: m[1], key: m[2] });
  return out;
}

/** 式の形になっていない `{{` / `}}` が残っているか（`{{ x }}` `{{a.b.c}}` など。打ち間違いを保存時に知らせる） */
export function hasMalformedTemplate(template: string): boolean {
  const rest = template.replace(new RegExp(EXPR_SOURCE, 'g'), '');
  return rest.includes('{{') || rest.includes('}}');
}

/** 参照（式 1 つだけ）を読む。形が違えば null */
export function parseRef(ref: string): FlowTemplateRef | null {
  const m = REF_PATTERN.exec(ref);
  return m ? { node: m[1], key: m[2] } : null;
}

export function makeRef(node: string, key: string): string {
  return `{{${node}.${key}}}`;
}

/** 展開に使う値の入れ物: `scope[nodeId][key]`。組み込みは `scope.run` `scope.org` */
export type FlowScope = Record<string, Record<string, unknown>>;

/** 自分のプロパティとしてある値だけを引く（`__proto__` `constructor` などは名前の段階で弾く） */
function lookup(scope: FlowScope, node: string, key: string): { found: boolean; value: unknown } {
  if (FLOW_RESERVED_KEYS.includes(key) || key === '__proto__') return { found: false, value: undefined };
  if (!hasOwn(scope, node)) return { found: false, value: undefined };
  const bag = scope[node];
  if (typeof bag !== 'object' || bag === null || !hasOwn(bag, key)) return { found: false, value: undefined };
  return { found: true, value: bag[key] };
}

/** UTF-8 で `maxBytes` に収まるように後ろを切る（サロゲートペアを割らない） */
export function clipUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) return { text: value, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const ch of value) {
    const b = utf8ByteLength(ch);
    if (bytes + b > maxBytes) break;
    bytes += b;
    end += ch.length;
  }
  return { text: value.slice(0, end), truncated: true };
}

export interface RenderedTemplate {
  text: string;
  /** 値が無い・文字にできない参照（`{{a.b}}` の形だけ。値は入れない） */
  warnings: string[];
  truncated: boolean;
}

/**
 * テンプレートを展開する（設計書 §6.4）。
 * - 置き換えは 1 回だけ。**値の中に `{{…}}` があっても展開しない**（AI や外部の出力が式として解釈されない。T3）
 * - 値は文字列・有限の数・真偽だけを文字にする。null・無い値・オブジェクト・配列は空文字にして `warnings` に 1 行
 * - 展開後は `maxBytes`（既定 32KB）で切る
 */
export function renderTemplate(
  template: string,
  scope: FlowScope,
  maxBytes: number = L.renderedMaxBytes,
): RenderedTemplate {
  const warnings: string[] = [];
  const replaced = template.replace(new RegExp(EXPR_SOURCE, 'g'), (_whole, node: string, key: string) => {
    const { found, value } = lookup(scope, node, key);
    if (found) {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'boolean') return String(value);
    }
    warnings.push(`{{${node}.${key}}} が空です`);
    return '';
  });
  const { text, truncated } = clipUtf8(replaced, maxBytes);
  return { text, warnings, truncated };
}

/** 参照の値をそのまま返す（分岐の `left`・`rows`）。形が違う・無いときは undefined */
export function resolveRef(ref: string, scope: FlowScope): unknown {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;
  return lookup(scope, parsed.node, parsed.key).value;
}

// ── 部品カタログの形（中身は flow-parts.ts。設計書 §5.7） ─────────────────────

export type FlowValueType = 'text' | 'number' | 'boolean' | 'rows';

export interface FlowPartOutputSpec {
  key: string;
  type: FlowValueType;
  /** rows の列（宣言した列だけを受け取る） */
  columns?: { key: string; type: Exclude<FlowValueType, 'rows'> }[];
}

export interface FlowPartSpec {
  key: string;
  title: string;
  icon: PageIcon;
  via: { kind: 'n8n' } | { kind: 'capability'; name: string };
  input: PageField[];
  output: FlowPartOutputSpec[];
  /** external_send は必ず承認で止まる（設計書 §7.4） */
  sideEffect: 'none' | 'external_send';
  idempotent: boolean;
  minPlan: Plan;
  timeoutMs?: number;
}

// ── データノードの資源（許可リスト。設計書 §6.5） ─────────────────────────

export const FLOW_DATA_RESOURCE_KEYS = ['deal', 'project', 'vendor', 'cost_entry', 'deliverable'] as const;
export type FlowDataResource = (typeof FLOW_DATA_RESOURCE_KEYS)[number];
export const FLOW_DATA_OPS = ['list', 'get', 'create', 'update'] as const;
export type FlowDataOp = (typeof FLOW_DATA_OPS)[number];

export interface FlowDataResourceSpec {
  ops: readonly FlowDataOp[];
  /** 読める列と型（出力のキー） */
  fields: Readonly<Record<string, Exclude<FlowValueType, 'rows'>>>;
  /** where に書ける列（等値だけ） */
  filterable: readonly string[];
  /** create / update の values に書ける列 */
  writable: readonly string[];
  /** create で必ず要る列 */
  required: readonly string[];
}

/**
 * 資源ごとの列と操作。メンバー・契約・連携・監査などの表は**ここに無い**＝読めない（T14）。
 * `cost_entry` は create だけで、ランナーが必ず `status='DRAFT'` で積む（AI が読んだ数字は下書き）。
 */
export const FLOW_DATA_RESOURCES: Readonly<Record<FlowDataResource, FlowDataResourceSpec>> = {
  deal: {
    ops: ['list', 'get', 'create', 'update'],
    fields: { id: 'text', title: 'text', company: 'text', amount: 'number', stage: 'text' },
    filterable: ['id', 'title', 'company', 'stage'],
    writable: ['title', 'company', 'amount', 'stage'],
    required: ['title'],
  },
  project: {
    ops: ['list', 'get'],
    fields: { id: 'text', code: 'text', name: 'text', client: 'text', contractAmount: 'number', status: 'text' },
    filterable: ['id', 'code', 'status'],
    writable: [],
    required: [],
  },
  vendor: {
    ops: ['list', 'get'],
    fields: { id: 'text', name: 'text', kind: 'text', invoiceRegistered: 'boolean' },
    filterable: ['id', 'name', 'kind', 'invoiceRegistered'],
    writable: [],
    required: [],
  },
  cost_entry: {
    ops: ['create'],
    fields: {
      id: 'text',
      projectId: 'text',
      vendorId: 'text',
      category: 'text',
      amount: 'number',
      taxAmount: 'number',
      incurredOn: 'text',
      description: 'text',
      status: 'text',
    },
    filterable: [],
    writable: ['projectId', 'vendorId', 'category', 'amount', 'taxAmount', 'incurredOn', 'description'],
    required: ['projectId', 'category', 'amount', 'incurredOn'],
  },
  deliverable: {
    ops: ['list'],
    fields: { id: 'text', title: 'text', department: 'text', createdAt: 'text' },
    filterable: ['department'],
    writable: [],
    required: [],
  },
};

// ── 出力のキー（次のノードが参照できるもの。設計書 §6.2） ──────────────────────

export interface FlowOutputKey {
  key: string;
  type: FlowValueType;
  /** rows の列 */
  columns?: string[];
}

function fieldValueType(type: PageField['type']): Exclude<FlowValueType, 'rows'> {
  if (type === 'number') return 'number';
  if (type === 'checkbox') return 'boolean';
  return 'text';
}

/** そのノードが出す値のキーと型。部品はカタログ（`parts`）から引く。知らない部品は空 */
export function outputKeysOf(node: FlowNode, parts: readonly FlowPartSpec[] = []): FlowOutputKey[] {
  switch (node.type) {
    case 'trigger':
      return node.config.mode === 'form'
        ? node.config.fields.map((f) => ({ key: f.key, type: fieldValueType(f.type) }))
        : [];
    case 'ai':
      if (node.config.op === 'extract') return (node.config.fields ?? []).map((f) => ({ key: f.key, type: f.type }));
      if (node.config.op === 'classify') return [{ key: 'choice', type: 'text' }];
      return [{ key: 'text', type: 'text' }];
    case 'approval':
      return [
        { key: 'approvedBy', type: 'text' },
        { key: 'approvedAt', type: 'text' },
      ];
    case 'data': {
      const spec = hasOwn(FLOW_DATA_RESOURCES, node.config.resource)
        ? FLOW_DATA_RESOURCES[node.config.resource]
        : undefined;
      if (!spec) return [];
      if (node.config.op === 'list') {
        return [
          { key: 'rows', type: 'rows', columns: Object.keys(spec.fields) },
          { key: 'count', type: 'number' },
        ];
      }
      return Object.entries(spec.fields).map(([key, type]) => ({ key, type }));
    }
    case 'part': {
      const spec = parts.find((p) => p.key === node.config.part);
      if (!spec) return [];
      return spec.output.map((o) =>
        o.type === 'rows' ? { key: o.key, type: 'rows', columns: (o.columns ?? []).map((c) => c.key) } : { key: o.key, type: o.type },
      );
    }
    case 'branch':
      return [{ key: 'result', type: 'boolean' }];
    case 'output':
      if (node.config.kind === 'page') return Object.keys(node.config.values).map((key) => ({ key, type: 'text' }));
      if (node.config.kind === 'document') return [{ key: 'taskId', type: 'text' }];
      return [{ key: 'sent', type: 'boolean' }];
    default:
      return [];
  }
}

/** 組み込みの参照の出力キー（差し込みの候補の先頭に出す） */
export function builtinOutputKeys(): { node: string; keys: FlowOutputKey[] }[] {
  return Object.entries(FLOW_BUILTIN_REFS).map(([node, keys]) => ({
    node,
    keys: keys.map((key) => ({ key, type: 'text' as const })),
  }));
}

/** そのノードの設定のうち、式・参照を書ける項目（検証と web の差し込みの候補で使う） */
export interface FlowTemplateSlot {
  path: (string | number)[];
  value: string;
  /** text: 文字の中に式を埋める / rows: 表への参照 1 つ / any: 値への参照 1 つ（分岐の left） */
  accepts: 'text' | 'rows' | 'any';
}

export function templateSlotsOf(node: FlowNode): FlowTemplateSlot[] {
  const slots: FlowTemplateSlot[] = [];
  const text = (path: (string | number)[], value: string | undefined) => {
    if (typeof value === 'string') slots.push({ path, value, accepts: 'text' });
  };
  const record = (base: string, values: Record<string, string> | undefined) => {
    if (!values) return;
    for (const [k, v] of Object.entries(values)) text(['config', base, k], v);
  };
  switch (node.type) {
    case 'ai':
      text(['config', 'instruction'], node.config.instruction);
      text(['config', 'input'], node.config.input);
      break;
    case 'approval':
      text(['config', 'message'], node.config.message);
      text(['config', 'preview'], node.config.preview);
      break;
    case 'data':
      (node.config.where ?? []).forEach((w, i) => text(['config', 'where', i, 'value'], w.value));
      record('values', node.config.values);
      break;
    case 'part':
      record('input', node.config.input);
      break;
    case 'branch':
      slots.push({ path: ['config', 'left'], value: node.config.left, accepts: 'any' });
      break;
    case 'output':
      if (node.config.kind === 'page') {
        record('values', node.config.values);
        if (node.config.rows !== undefined) slots.push({ path: ['config', 'rows'], value: node.config.rows, accepts: 'rows' });
      } else if (node.config.kind === 'document') {
        text(['config', 'title'], node.config.title);
        text(['config', 'body'], node.config.body);
      } else {
        text(['config', 'to'], node.config.to);
        text(['config', 'body'], node.config.body);
      }
      break;
    default:
      break;
  }
  return slots;
}

// ── グラフ（設計書 §6.7） ──────────────────────────────────────

type GraphLike = Pick<FlowDefinition, 'nodes' | 'edges'>;

/**
 * トポロジカル順（Kahn 法）。同じ段は `nodes` の並び順。循環があれば null。
 * 存在しないノードを指す線は無視する（検査は `checkFlowDefinition`）。
 */
export function topoOrder(def: GraphLike): string[] | null {
  const ids = def.nodes.map((n) => n.id);
  const index = new Map<string, number>(ids.map((id, i) => [id, i]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of def.edges) {
    if (!index.has(e.from) || !index.has(e.to)) continue;
    out.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const ready = ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const id = ready.shift() as string;
    order.push(id);
    for (const to of out.get(id) ?? []) {
      const d = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, d);
      if (d === 0) ready.push(to);
    }
  }
  return order.length === ids.length ? order : null;
}

/** そのノードの上流（祖先）すべて。自分は含まない */
export function upstreamOf(def: GraphLike, nodeId: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of def.edges) {
    const list = incoming.get(e.to) ?? [];
    list.push(e.from);
    incoming.set(e.to, list);
  }
  const seen = new Set<string>();
  const stack = [...(incoming.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id) || id === nodeId) continue;
    seen.add(id);
    stack.push(...(incoming.get(id) ?? []));
  }
  return seen;
}

/** 直前のノード（入る線の元） */
export function predecessorsOf(def: GraphLike, nodeId: string): string[] {
  return def.edges.filter((e) => e.to === nodeId).map((e) => e.from);
}

/** 外へ送るノードか（`external_send` の部品・`output(notify)`）。知らない部品も送る側に倒す（fail-closed） */
export function isExternalSendNode(node: FlowNode, parts: readonly FlowPartSpec[] = []): boolean {
  if (node.type === 'output') return node.config.kind === 'notify';
  if (node.type === 'part') {
    const spec = parts.find((p) => p.key === node.config.part);
    return !spec || spec.sideEffect !== 'none';
  }
  return false;
}

// ── 検査 ──────────────────────────────────────────────────

export interface FlowIssue {
  path: (string | number)[];
  message: string;
  /** 画面で該当ノードに印を付けるため */
  nodeId?: string;
}

/**
 * フロー定義のグラフと参照の検査（設計書 §6.7）。形（型・文字数）は flows.ts の zod が見る。
 * 問題が無ければ空配列。web は保存前に同じ検査で該当ノードに印を付ける。
 */
export function checkFlowDefinition(def: FlowDefinition, parts: readonly FlowPartSpec[] = []): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const add = (path: (string | number)[], message: string, nodeId?: string) =>
    issues.push(nodeId === undefined ? { path, message } : { path, message, nodeId });

  // ノード ID
  const byId = new Map<string, FlowNode>();
  const indexOf = new Map<string, number>();
  def.nodes.forEach((node, i) => {
    if (FLOW_RESERVED_NODE_IDS.includes(node.id)) add(['nodes', i, 'id'], `ID "${node.id}" は使えません`, node.id);
    if (byId.has(node.id)) add(['nodes', i, 'id'], `ID "${node.id}" が重複しています`, node.id);
    else {
      byId.set(node.id, node);
      indexOf.set(node.id, i);
    }
  });

  // 型ごとの数
  const count = (type: FlowNode['type']) => def.nodes.filter((n) => n.type === type).length;
  const triggers = def.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) add(['nodes'], 'きっかけはちょうど 1 つ必要です');
  if (count('ai') > L.maxAiNodes) add(['nodes'], `AI は ${L.maxAiNodes} 個までです`);
  if (count('part') > L.maxPartNodes) add(['nodes'], `部品は ${L.maxPartNodes} 個までです`);
  if (count('branch') > L.maxBranchNodes) add(['nodes'], `分岐は ${L.maxBranchNodes} 個までです`);
  const pageOutputs = def.nodes.filter((n) => n.type === 'output' && n.config.kind === 'page');
  if (pageOutputs.length > L.maxPageOutputs) add(['nodes'], `ページの出力は ${L.maxPageOutputs} つまでです`);

  // 線
  const seenEdges = new Set<string>();
  let edgesOk = true;
  def.edges.forEach((e, i) => {
    const at = ['edges', i];
    if (!byId.has(e.from) || !byId.has(e.to)) {
      add(at, '線の端のノードがありません');
      edgesOk = false;
      return;
    }
    if (e.from === e.to) {
      add(at, '自分に戻る線は引けません', e.from);
      edgesOk = false;
      return;
    }
    const k = `${e.from}\u0000${e.to}`;
    if (seenEdges.has(k)) add(at, '同じ線が重複しています', e.from);
    seenEdges.add(k);
    const from = byId.get(e.from) as FlowNode;
    if (from.type !== 'branch' && e.when !== undefined) add([...at, 'when'], 'yes / no は分岐から出る線だけに付けます', e.from);
    if (from.type === 'branch' && e.when === undefined) add([...at, 'when'], '分岐から出る線には yes か no が要ります', e.from);
    if (byId.get(e.to)?.type === 'trigger') add(at, 'きっかけに入る線は引けません', e.to);
  });
  for (const node of def.nodes) {
    const outs = def.edges.filter((e) => e.from === node.id);
    const i = indexOf.get(node.id) ?? 0;
    if (node.type === 'branch') {
      if (outs.filter((e) => e.when === 'yes').length > 1) add(['nodes', i], 'yes の線は 1 本までです', node.id);
      if (outs.filter((e) => e.when === 'no').length > 1) add(['nodes', i], 'no の線は 1 本までです', node.id);
    } else if (outs.length > L.maxOutDegree) {
      add(['nodes', i], `出る線は ${L.maxOutDegree} 本までです`, node.id);
    }
  }

  // DAG と到達
  const order = edgesOk ? topoOrder(def) : null;
  if (edgesOk && order === null) add(['edges'], '線が輪になっています（繰り返しはできません）');
  if (triggers.length === 1 && edgesOk) {
    const reach = new Set<string>([triggers[0].id]);
    const stack = [triggers[0].id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      for (const e of def.edges) {
        if (e.from === id && !reach.has(e.to)) {
          reach.add(e.to);
          stack.push(e.to);
        }
      }
    }
    def.nodes.forEach((node, i) => {
      if (!reach.has(node.id)) add(['nodes', i], 'きっかけから線がつながっていません', node.id);
    });
  }

  // 参照（式）: 上流のノードの、出力にあるキーだけ
  if (order !== null) {
    def.nodes.forEach((node, i) => {
      const up = upstreamOf(def, node.id);
      for (const slot of templateSlotsOf(node)) {
        const at = ['nodes', i, ...slot.path];
        let refs: FlowTemplateRef[];
        if (slot.accepts === 'text') {
          if (hasMalformedTemplate(slot.value)) add(at, '差し込みの形が違います（{{ノード.キー}}）', node.id);
          refs = parseTemplateRefs(slot.value);
        } else {
          const ref = parseRef(slot.value);
          if (!ref) {
            add(at, '値の参照を 1 つ選んでください', node.id);
            continue;
          }
          refs = [ref];
        }
        for (const ref of refs) {
          if (hasOwn(FLOW_BUILTIN_REFS, ref.node)) {
            if (!FLOW_BUILTIN_REFS[ref.node].includes(ref.key)) add(at, `{{${ref.node}.${ref.key}}} はありません`, node.id);
            else if (slot.accepts === 'rows') add(at, '表を出すノードを選んでください', node.id);
            continue;
          }
          const target = byId.get(ref.node);
          if (!target || !up.has(ref.node)) {
            add(at, `{{${ref.node}.${ref.key}}} は前のノードではありません`, node.id);
            continue;
          }
          const key = outputKeysOf(target, parts).find((k) => k.key === ref.key);
          if (!key) {
            add(at, `{{${ref.node}.${ref.key}}} はありません`, node.id);
          } else if (slot.accepts === 'text' && key.type === 'rows') {
            add(at, `{{${ref.node}.${ref.key}}} は表なので文字に入れられません`, node.id);
          } else if (slot.accepts === 'rows' && key.type !== 'rows') {
            add(at, `{{${ref.node}.${ref.key}}} は表ではありません`, node.id);
          } else if (
            slot.accepts === 'any' &&
            key.type === 'rows' &&
            node.type === 'branch' &&
            node.config.op !== 'empty' &&
            node.config.op !== 'not_empty'
          ) {
            add(at, '表は「空」「空でない」でだけ比べられます', node.id);
          }
        }
      }
    });
  }

  // 部品: カタログにあり、入力が部品の項目と合う
  def.nodes.forEach((node, i) => {
    if (node.type !== 'part') return;
    const spec = parts.find((p) => p.key === node.config.part);
    if (!spec) {
      add(['nodes', i, 'config', 'part'], `部品 "${node.config.part}" はありません`, node.id);
      return;
    }
    const fieldKeys = spec.input.map((f) => f.key);
    for (const k of Object.keys(node.config.input)) {
      if (!fieldKeys.includes(k)) add(['nodes', i, 'config', 'input', k], `部品に項目 "${k}" はありません`, node.id);
    }
    for (const f of spec.input) {
      if (f.required && !(hasOwn(node.config.input, f.key) && node.config.input[f.key].trim() !== '')) {
        add(['nodes', i, 'config', 'input', f.key], `「${f.label}」は必須です`, node.id);
      }
    }
  });

  // 外へ送るノードの直前には確認（無くてもランナーが止めるが、画面で見えるようにする。§7.4）
  def.nodes.forEach((node, i) => {
    if (!isExternalSendNode(node, parts)) return;
    const preds = predecessorsOf(def, node.id);
    const allApproval = preds.length > 0 && preds.every((p) => byId.get(p)?.type === 'approval');
    if (!allApproval) add(['nodes', i], '送る前に「確認」を置いてください', node.id);
  });

  return issues;
}

// ── 小物 ──────────────────────────────────────────────────

/** 定義に部品ノードがあるか（受け付けで部品の月間上限を見るか決める） */
export function definitionUsesParts(def: Pick<FlowDefinition, 'nodes'>): boolean {
  return def.nodes.some((n) => n.type === 'part');
}

/** 1 行の文字（ラベル・名前）として使えるか */
export function isSingleLineText(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max && !hasControlChars(value);
}
