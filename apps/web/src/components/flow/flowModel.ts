import {
  FLOW_BUILTIN_REFS,
  FLOW_DEFINITION_LIMITS as L,
  FLOW_NODE_TYPE_LABEL,
  builtinOutputKeys,
  makeRef,
  parseRef,
  outputKeysOf,
  topoOrder,
  upstreamOf,
  type FlowDefinition,
  type FlowEdge,
  type FlowNode,
  type FlowNodeType,
  type FlowPartSpec,
  type FlowStepState,
  type FlowStepStatus,
  type FlowRunStatus,
  type FlowValueType,
} from '@org-ai/shared-types';

/**
 * フロー画面（docs/design/canvas-home.md §3.4・§4.3）の純粋関数。定義（`FlowDefinition`）を受けて新しい定義を返す。
 * 検証の正本は gateway の `flowDefinitionSchema`（保存時）。PC の編集画面は同じスキーマで入力中のエラーを出す。
 * ⚠️ zod の値も `@xyflow/react` も import しない（スマホのステップリストが読む。K20・K29）。
 */

export type FlowLayoutMap = Record<string, { x: number; y: number }>;

/** gateway が返す定義は古い形もありうる（valid: false）。描くのに要る形だけ揃える */
export function normalizeDefinition(raw: unknown): FlowDefinition {
  const r = (raw ?? {}) as Partial<FlowDefinition>;
  return {
    nodes: Array.isArray(r.nodes) ? r.nodes.filter((n) => n && typeof n.id === 'string') : [],
    edges: Array.isArray(r.edges) ? r.edges.filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string') : [],
  } as FlowDefinition;
}

export function normalizeLayout(raw: unknown): FlowLayoutMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FlowLayoutMap = {};
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    const pos = p as { x?: unknown; y?: unknown } | null;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') out[id] = { x: pos.x, y: pos.y };
  }
  return out;
}

// ── 並び（スマホの番号・PC の矢印キー。§4.3） ───────────────────────────

export interface StepRow {
  node: FlowNode;
  /** 「1」「3a」 */
  number: string;
  /** 同じ段に 2 つ以上あるとき 1（字下げ 1 段だけ） */
  depth: 0 | 1;
}

/**
 * ステップの縦リスト。段（前のノードがすべて済んだ段＝K65 と同じ考え方）ごとに番号を振り、
 * 同じ段に複数あれば「3a / 3b」と字下げ 1 段。循環（保存前の壊れた形）は定義の並び順に 1 から。
 */
export function stepRows(def: FlowDefinition): StepRow[] {
  const order = topoOrder(def);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  if (!order) return def.nodes.map((node, i) => ({ node, number: String(i + 1), depth: 0 }));
  const layer = new Map<string, number>();
  for (const id of order) {
    const preds = def.edges.filter((e) => e.to === id && byId.has(e.from)).map((e) => layer.get(e.from) ?? 0);
    layer.set(id, preds.length === 0 ? 0 : Math.max(...preds) + 1);
  }
  const groups = new Map<number, string[]>();
  for (const id of order) {
    const l = layer.get(id) ?? 0;
    groups.set(l, [...(groups.get(l) ?? []), id]);
  }
  const rows: StepRow[] = [];
  [...groups.keys()]
    .sort((a, b) => a - b)
    .forEach((l, i) => {
      const ids = groups.get(l) ?? [];
      ids.forEach((id, j) => {
        const node = byId.get(id);
        if (!node) return;
        const multi = ids.length > 1;
        rows.push({ node, number: multi ? `${i + 1}${String.fromCharCode(97 + Math.min(j, 25))}` : String(i + 1), depth: multi ? 1 : 0 });
      });
    });
  return rows;
}

// ── 値の差し込み（§3.4・§6.4。手で式を書かせない） ─────────────────────────

export type SlotAccepts = 'text' | 'rows' | 'any';

export interface InsertCandidate {
  node: string;
  label: string;
  keys: { key: string; type: FlowValueType; ref: string; title: string }[];
}

/** 出力キーの見出し: フォームの項目・取り出す項目は利用者が付けた名前、他は一語（知らないキーはそのまま） */
function keyTitle(node: FlowNode | null, key: string): string {
  if (node?.type === 'trigger' && node.config.mode === 'form') {
    const f = node.config.fields.find((x) => x.key === key);
    if (f) return f.label;
  }
  if (node?.type === 'ai' && node.config.op === 'extract') {
    const f = (node.config.fields ?? []).find((x) => x.key === key);
    if (f) return f.label;
  }
  return OUTPUT_KEY_LABEL[key] ?? key;
}

function acceptsType(accepts: SlotAccepts, type: FlowValueType): boolean {
  if (accepts === 'rows') return type === 'rows';
  if (accepts === 'text') return type !== 'rows';
  return true;
}

/** そのノードに差し込める値: 上流のノードの出力キー（線をたどった順）と、文字なら組み込み（実行日など）。空の候補は出さない */
export function insertCandidates(
  def: FlowDefinition,
  nodeId: string,
  parts: readonly FlowPartSpec[],
  accepts: SlotAccepts = 'text',
): InsertCandidate[] {
  const up = upstreamOf(def, nodeId);
  const order = topoOrder(def) ?? def.nodes.map((n) => n.id);
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const out: InsertCandidate[] = [];
  for (const id of order) {
    if (!up.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    const keys = outputKeysOf(node, parts)
      .filter((k) => acceptsType(accepts, k.type))
      .map((k) => ({ key: k.key, type: k.type, ref: makeRef(node.id, k.key), title: keyTitle(node, k.key) }));
    if (keys.length > 0) out.push({ node: node.id, label: node.label, keys });
  }
  if (accepts === 'text') {
    for (const b of builtinOutputKeys()) {
      out.push({
        node: b.node,
        label: BUILTIN_LABEL[b.node] ?? b.node,
        keys: b.keys.map((k) => ({ key: k.key, type: k.type, ref: makeRef(b.node, k.key), title: keyTitle(null, k.key) })),
      });
    }
  }
  return out;
}

const BUILTIN_LABEL: Record<string, string> = { run: '実行', org: '組織' };

/** 差し込みの候補の見出し（キーの一語）。知らないキーはそのまま */
export const OUTPUT_KEY_LABEL: Record<string, string> = {
  text: '文章',
  choice: '分類',
  approvedBy: '承認者',
  approvedAt: '承認日時',
  rows: '表',
  count: '件数',
  result: '結果',
  taskId: '成果物',
  sent: '送信',
  date: '実行日',
  id: 'ID',
  name: '名前',
  url: 'URL',
};

/** 参照（`{{node.key}}`）の見出し（「フォーム › 金額」）。形が違えば空 */
export function describeRef(def: FlowDefinition, ref: string): string {
  const p = parseRef(ref);
  if (!p) return '';
  if (isBuiltinRef(p.node)) return `${BUILTIN_LABEL[p.node] ?? p.node} › ${keyTitle(null, p.key)}`;
  const node = def.nodes.find((n) => n.id === p.node) ?? null;
  return `${node?.label ?? p.node} › ${keyTitle(node, p.key)}`;
}

export function isBuiltinRef(node: string): boolean {
  return Object.prototype.hasOwnProperty.call(FLOW_BUILTIN_REFS, node);
}

// ── 検証エラーをノードへ（§3.4「該当ノードに danger の点＋右パネルに 1 行」） ──────────────

export interface FlowIssueLike {
  path: (string | number)[];
  message: string;
  nodeId?: string;
}

export interface IssueMap {
  nodes: Record<string, string[]>;
  /** どのノードとも言えないもの（上部に 1 行） */
  general: string[];
}

/** 検証の問題（gateway の `issues` か、画面での同じ検査）を、定義のノード ID ごとに分ける */
export function issuesByNode(def: FlowDefinition, issues: readonly FlowIssueLike[]): IssueMap {
  const nodes: Record<string, string[]> = {};
  const general: string[] = [];
  const push = (id: string, m: string) => {
    const list = (nodes[id] ??= []);
    if (!list.includes(m)) list.push(m);
  };
  for (const issue of issues) {
    const [head, index] = issue.path;
    let id: string | undefined = issue.nodeId;
    if (!id && head === 'nodes' && typeof index === 'number') id = def.nodes[index]?.id;
    if (!id && head === 'edges' && typeof index === 'number') id = def.edges[index]?.from;
    if (id && def.nodes.some((n) => n.id === id)) push(id, issue.message);
    else if (!general.includes(issue.message)) general.push(issue.message);
  }
  return { nodes, general };
}

// ── 編集（PC。§3.4） ─────────────────────────────────────────

/** 新しいノードの ID（`ai1` `ai2` …。NodeId の形） */
export function nextFlowNodeId(def: FlowDefinition, type: FlowNodeType): string {
  const ids = new Set(def.nodes.map((n) => n.id));
  for (let i = 1; ; i++) if (!ids.has(`${type}${i}`)) return `${type}${i}`;
}

/** 追加メニューに出す型（きっかけは 1 つだけ。上限に達した型は出さない） */
export function addableTypes(def: FlowDefinition): FlowNodeType[] {
  const count = (t: FlowNodeType) => def.nodes.filter((n) => n.type === t).length;
  const out: FlowNodeType[] = [];
  if (def.nodes.length >= L.maxNodes) return out;
  if (count('trigger') === 0) out.push('trigger');
  if (count('ai') < L.maxAiNodes) out.push('ai');
  out.push('approval', 'data');
  if (count('part') < L.maxPartNodes) out.push('part');
  if (count('branch') < L.maxBranchNodes) out.push('branch');
  out.push('output');
  return out;
}

/** 型ごとの初期値。保存できない値（空の指示など）は置かず、すぐ保存できる形にする */
export function defaultNode(def: FlowDefinition, type: FlowNodeType, parts: readonly FlowPartSpec[]): FlowNode {
  const id = nextFlowNodeId(def, type);
  const label = FLOW_NODE_TYPE_LABEL[type];
  switch (type) {
    case 'trigger':
      return { id, type, label, config: { mode: 'manual' } };
    case 'ai':
      return { id, type, label, config: { op: 'generate', instruction: '文章を作ってください', input: '' } };
    case 'approval':
      return { id, type, label, config: { message: '内容を確認してください' } };
    case 'data':
      return { id, type, label, config: { resource: 'deal', op: 'list', limit: 10 } };
    case 'part': {
      const part = parts[0];
      return {
        id,
        type,
        label: part?.title.slice(0, L.labelMax) ?? label,
        config: { part: part?.key ?? 'google_doc', input: Object.fromEntries((part?.input ?? []).map((f) => [f.key, ''])) },
      };
    }
    case 'branch':
      return { id, type, label, config: { left: '', op: 'not_empty' } };
    case 'output': {
      const hasPage = def.nodes.some((n) => n.type === 'output' && n.config.kind === 'page');
      return hasPage
        ? { id, type, label: '文書', config: { kind: 'document', title: '文書', body: '本文' } }
        : { id, type, label, config: { kind: 'page', values: {} } };
    }
    default:
      return { id, type: 'trigger', label, config: { mode: 'manual' } };
  }
}

export interface EditResult {
  def: FlowDefinition;
  layout: FlowLayoutMap;
  id: string;
}

/**
 * ノードを足す。`after` を渡すとそのノードから線を引き、`onEdge` を渡すとその線の途中に挟む（分岐の yes / no は引き継ぐ）。
 * ノード数の上限なら null。
 */
export function addFlowNode(
  def: FlowDefinition,
  layout: FlowLayoutMap,
  node: FlowNode,
  opts: { after?: string; onEdge?: FlowEdge } = {},
): EditResult | null {
  if (def.nodes.length >= L.maxNodes) return null;
  if (node.type === 'trigger' && def.nodes.some((n) => n.type === 'trigger')) return null;
  let edges = [...def.edges];
  const anchor = opts.onEdge?.from ?? opts.after;
  if (opts.onEdge) {
    const e = opts.onEdge;
    edges = edges.filter((x) => !(x.from === e.from && x.to === e.to));
    edges.push(e.when ? { from: e.from, to: node.id, when: e.when } : { from: e.from, to: node.id });
    edges.push({ from: node.id, to: e.to });
  } else if (opts.after && def.nodes.some((n) => n.id === opts.after)) {
    const from = def.nodes.find((n) => n.id === opts.after) as FlowNode;
    const edge = edgeFrom(def, from, node.id);
    if (edge) edges.push(edge);
  }
  const base = anchor ? layout[anchor] : undefined;
  const ys = Object.values(layout).map((p) => p.y);
  const pos = base ? { x: base.x, y: base.y + 140 } : { x: 0, y: ys.length ? Math.max(...ys) + 140 : 0 };
  const next: FlowDefinition = { nodes: [...def.nodes, node], edges };
  const nextLayout = { ...layout, [node.id]: pos };
  if (opts.onEdge) {
    // 挟んだ先から下を 1 段ずらす（重ならないように）
    const below = new Set([opts.onEdge.to, ...downstreamOf(next, opts.onEdge.to)]);
    for (const id of below) {
      const p = nextLayout[id];
      if (p && id !== node.id) nextLayout[id] = { x: p.x, y: p.y + 140 };
    }
  }
  return { def: next, layout: nextLayout, id: node.id };
}

function downstreamOf(def: FlowDefinition, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const e of def.edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

/** 分岐から出る線は yes → no の順に埋める。両方あれば引けない */
function edgeFrom(def: FlowDefinition, from: FlowNode, to: string): FlowEdge | null {
  if (from.type !== 'branch') return { from: from.id, to };
  const outs = def.edges.filter((e) => e.from === from.id);
  if (!outs.some((e) => e.when === 'yes')) return { from: from.id, to, when: 'yes' };
  if (!outs.some((e) => e.when === 'no')) return { from: from.id, to, when: 'no' };
  return null;
}

/** 線を引く。自己ループ・重複・きっかけに入る線・端の無い線・上限超えは何もしない（同じ定義を返す） */
export function connectFlowNodes(def: FlowDefinition, from: string, to: string): FlowDefinition {
  if (from === to) return def;
  const src = def.nodes.find((n) => n.id === from);
  const dst = def.nodes.find((n) => n.id === to);
  if (!src || !dst || dst.type === 'trigger') return def;
  if (def.edges.some((e) => e.from === from && e.to === to)) return def;
  if (def.edges.length >= L.maxEdges) return def;
  const edge = edgeFrom(def, src, to);
  return edge ? { ...def, edges: [...def.edges, edge] } : def;
}

export function removeFlowEdge(def: FlowDefinition, from: string, to: string): FlowDefinition {
  return { ...def, edges: def.edges.filter((e) => !(e.from === from && e.to === to)) };
}

/** ノードを消す（きっかけは消せない）。入る線が 1 本・出る線が 1 本なら前後をつなぎ直す */
export function removeFlowNodes(def: FlowDefinition, layout: FlowLayoutMap, ids: readonly string[]): { def: FlowDefinition; layout: FlowLayoutMap } {
  let next = def;
  const nextLayout = { ...layout };
  for (const id of ids) {
    const node = next.nodes.find((n) => n.id === id);
    if (!node || node.type === 'trigger') continue;
    const ins = next.edges.filter((e) => e.to === id);
    const outs = next.edges.filter((e) => e.from === id);
    let edges = next.edges.filter((e) => e.from !== id && e.to !== id);
    if (ins.length === 1 && outs.length === 1 && !edges.some((e) => e.from === ins[0].from && e.to === outs[0].to)) {
      const bridge: FlowEdge = ins[0].when ? { from: ins[0].from, to: outs[0].to, when: ins[0].when } : { from: ins[0].from, to: outs[0].to };
      if (bridge.from !== bridge.to) edges = [...edges, bridge];
    }
    next = { nodes: next.nodes.filter((n) => n.id !== id), edges };
    delete nextLayout[id];
  }
  return { def: next, layout: nextLayout };
}

export function replaceNode(def: FlowDefinition, node: FlowNode): FlowDefinition {
  return { ...def, nodes: def.nodes.map((n) => (n.id === node.id ? node : n)) };
}

/** 変更があるか（保存ボタンを主にする・未保存では実行させない判定） */
export function flowChanged(
  a: { def: FlowDefinition; layout: FlowLayoutMap; name: string },
  b: { def: FlowDefinition; layout: FlowLayoutMap; name: string },
): boolean {
  return a.name !== b.name || JSON.stringify(a.def) !== JSON.stringify(b.def) || JSON.stringify(a.layout) !== JSON.stringify(b.layout);
}

// ── 実行の表示 ───────────────────────────────────────────────

export const RUN_STATUS_LABEL: Record<FlowRunStatus, string> = {
  QUEUED: '待ち',
  RUNNING: '実行中',
  WAITING_APPROVAL: '承認待ち',
  SUCCEEDED: '完了',
  FAILED: '失敗',
  CANCELED: '取消',
  EXPIRED: '期限切れ',
};

export const STEP_STATUS_LABEL: Record<FlowStepStatus, string> = {
  PENDING: '待ち',
  RUNNING: '実行中',
  SUCCEEDED: '完了',
  FAILED: '失敗',
  SKIPPED: '対象外',
  WAITING_APPROVAL: '承認待ち',
};

export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'muted';

export function stepTone(status: string | undefined): Tone {
  switch (status) {
    case 'SUCCEEDED':
      return 'success';
    case 'FAILED':
    case 'EXPIRED':
      return 'danger';
    case 'WAITING_APPROVAL':
      return 'warning';
    case 'RUNNING':
    case 'QUEUED':
      return 'info';
    default:
      return 'muted';
  }
}

export function labelOfRunStatus(status: string): string {
  return (RUN_STATUS_LABEL as Record<string, string>)[status] ?? status;
}

export function labelOfStepStatus(status: string): string {
  return (STEP_STATUS_LABEL as Record<string, string>)[status] ?? status;
}

/** 所要時間（「4.2 秒」「1 分 5 秒」） */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 結果の先頭（右パネル・シートに出す）。文字はそのまま React のテキストで出す（T13） */
export function stepOutputHead(step: FlowStepState | undefined, max = 200): string {
  const out = step?.output;
  if (!out || typeof out !== 'object') return '';
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `${v.length} 行`;
    return null;
  };
  const preferred = ['text', 'choice'].map((k) => (Object.prototype.hasOwnProperty.call(out, k) ? pick(out[k]) : null)).find((v) => v);
  const text =
    preferred ??
    Object.entries(out)
      .map(([k, v]) => {
        const s = pick(v);
        return s === null ? null : `${OUTPUT_KEY_LABEL[k] ?? k}: ${s}`;
      })
      .filter((v): v is string => v !== null)
      .join('\n');
  return Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}…` : text;
}

// ── スマホの文字の変更（§4.1「名前・指示・確認の文言」。PATCH の node＝K46） ─────────────────

export interface TextField {
  key: string;
  label: string;
  value: string;
  multiline: boolean;
  max: number;
}

/** スマホで変えられる文字の項目（構造・参照先・宛先の種類は変えない）。ラベルは別に出す */
export function mobileTextFields(node: FlowNode): TextField[] {
  const f = (key: string, label: string, value: string | undefined, max: number, multiline = false): TextField[] =>
    typeof value === 'string' ? [{ key, label, value, max, multiline }] : [];
  switch (node.type) {
    case 'ai':
      return f('instruction', '指示', node.config.instruction, L.instructionMax, true);
    case 'approval':
      return [...f('message', '文言', node.config.message, L.approvalMessageMax), ...f('preview', '見せる内容', node.config.preview, L.approvalPreviewMax, true)];
    case 'output':
      if (node.config.kind === 'document') {
        return [...f('title', '題名', node.config.title, L.documentTitleMax), ...f('body', '本文', node.config.body, L.documentBodyMax, true)];
      }
      if (node.config.kind === 'notify') return f('body', '本文', node.config.body, L.notifyBodyMax, true);
      return [];
    default:
      return [];
  }
}
