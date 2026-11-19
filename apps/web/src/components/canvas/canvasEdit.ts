import {
  CANVAS_LAYOUT_LIMITS as CL,
  FLOW_TEMPLATES,
  isPageIcon,
  type CanvasLayout,
  type CanvasNode,
  type CanvasTarget,
  type FlowTemplateKey,
  type PageIcon,
} from '@org-ai/shared-types';
import type { CanvasFlowSummary } from './canvasToList';

/**
 * ホームキャンバスの編集モード（§3.2）の純粋関数。配置（`CanvasLayout`）を受けて新しい配置を返す。
 * 検証の正本は gateway の `canvasLayoutSchema`（保存時）。ここは画面で壊れた形を作らないための最小限。
 * ⚠️ zod の値も `@xyflow/react` も import しない。
 */

/** 閲覧モードと編集モードの ReactFlow の設定。閲覧モードではノードが動かない・繋がらない・消えない */
export function boardInteraction(editing: boolean) {
  return {
    nodesDraggable: editing,
    nodesConnectable: editing,
    elementsSelectable: editing,
    edgesFocusable: editing,
    /* ノードの中身が button なので、外側の枠にはフォーカスを置かない（Tab が二重にならない） */
    nodesFocusable: false,
    deleteKeyCode: editing ? ['Delete', 'Backspace'] : null,
  } as const;
}

/** 座標は −5000〜5000 の整数（gateway と同じ丸め） */
export function clampCoord(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(CL.coordMax, Math.max(CL.coordMin, Math.round(v)));
}

/** ラベルは一語（8 文字）。サロゲートを途中で切らない */
export function clampLabel(label: string): string {
  let out = '';
  for (const ch of Array.from(label.trim())) {
    if ((out + ch).length > CL.labelMax) break;
    out += ch;
  }
  return out || '業務';
}

export function moveNode(layout: CanvasLayout, id: string, x: number, y: number): CanvasLayout {
  return {
    ...layout,
    nodes: layout.nodes.map((n) => (n.id === id ? { ...n, x: clampCoord(x), y: clampCoord(y) } : n)),
  };
}

export function removeNodes(layout: CanvasLayout, ids: readonly string[]): CanvasLayout {
  const drop = new Set(ids);
  return {
    nodes: layout.nodes.filter((n) => !drop.has(n.id)),
    edges: layout.edges.filter((e) => !drop.has(e.from) && !drop.has(e.to)),
  };
}

/** 線を引く。自己ループ・重複・端の無い線・上限超えは何もしない（同じ配置を返す） */
export function connectNodes(layout: CanvasLayout, from: string, to: string): CanvasLayout {
  if (from === to) return layout;
  const ids = new Set(layout.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) return layout;
  if (layout.edges.some((e) => e.from === from && e.to === to)) return layout;
  if (layout.edges.length >= CL.maxEdges) return layout;
  return { ...layout, edges: [...layout.edges, { from, to }] };
}

export function removeEdge(layout: CanvasLayout, from: string, to: string): CanvasLayout {
  return { ...layout, edges: layout.edges.filter((e) => !(e.from === from && e.to === to)) };
}

/** 新しいノードの ID（`n1` `n2` …。NodeId の形 `^[a-z][a-z0-9_]{0,23}$`） */
export function nextNodeId(layout: CanvasLayout): string {
  const ids = new Set(layout.nodes.map((n) => n.id));
  for (let i = 1; ; i++) if (!ids.has(`n${i}`)) return `n${i}`;
}

export interface NewCanvasNode {
  label: string;
  icon: PageIcon;
  target: CanvasTarget;
}

/** 追加する位置: いちばん下の段の下（空なら原点） */
function placementOf(layout: CanvasLayout): { x: number; y: number } {
  if (layout.nodes.length === 0) return { x: 0, y: 0 };
  const maxY = Math.max(...layout.nodes.map((n) => n.y));
  const minX = Math.min(...layout.nodes.map((n) => n.x));
  return { x: clampCoord(minX), y: clampCoord(maxY + 160) };
}

/** ノードを足す。上限（40）なら null */
export function addNode(layout: CanvasLayout, node: NewCanvasNode): { layout: CanvasLayout; id: string } | null {
  if (layout.nodes.length >= CL.maxNodes) return null;
  const id = nextNodeId(layout);
  const { x, y } = placementOf(layout);
  const created: CanvasNode = { id, label: clampLabel(node.label), icon: node.icon, x, y, target: node.target };
  return { layout: { ...layout, nodes: [...layout.nodes, created] }, id };
}

/** 変更があるか（保存ボタンを主にする判定） */
export function layoutChanged(a: CanvasLayout, b: CanvasLayout): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

// ── 追加メニュー（§3.2: テンプレート／既存のフロー／画面） ─────────────────────

/**
 * 画面の一覧。行き先は shared-types の `CANVAS_LINK_PATHS`（固定のパスの許可リスト）と 1 対 1。
 * `Record` なので許可リストに足したら型エラーで気づく。
 */
export const CANVAS_SCREENS: Record<
  '/chat' | '/inbox' | '/inbox?tab=approvals' | '/deliverables' | '/dashboard' | '/agents' | '/sales' | '/analytics' | '/sns' | '/accounting' | '/settings',
  { label: string; icon: PageIcon }
> = {
  '/inbox': { label: '問い合わせ', icon: 'inbox' },
  '/inbox?tab=approvals': { label: '承認', icon: 'check-square' },
  '/accounting': { label: '原価', icon: 'hammer' },
  '/dashboard': { label: '数字', icon: 'chart-bar' },
  '/deliverables': { label: '成果物', icon: 'folder' },
  '/chat': { label: 'チャット', icon: 'message-circle' },
  '/agents': { label: 'エージェント', icon: 'briefcase' },
  '/sales': { label: '営業', icon: 'briefcase' },
  '/analytics': { label: '分析', icon: 'chart-bar' },
  '/sns': { label: 'SNS', icon: 'message-circle' },
  '/settings': { label: '設定', icon: 'wrench' },
};

export interface AddMenuEntry {
  key: string;
  label: string;
  icon: PageIcon;
  target: CanvasTarget;
  /** 既にキャンバスにある（同じ行き先を 2 つ置かない） */
  onCanvas: boolean;
}

export interface AddMenuSections {
  templates: AddMenuEntry[];
  flows: AddMenuEntry[];
  screens: AddMenuEntry[];
}

function sameTarget(a: CanvasTarget, b: CanvasTarget): boolean {
  if (a.kind === 'flow' && b.kind === 'flow') return a.flowId === b.flowId;
  if (a.kind === 'template' && b.kind === 'template') return a.templateKey === b.templateKey;
  if (a.kind === 'link' && b.kind === 'link') return a.to === b.to;
  return false;
}

export function addMenuSections(layout: CanvasLayout, flows: readonly CanvasFlowSummary[]): AddMenuSections {
  const on = (t: CanvasTarget) => layout.nodes.some((n) => sameTarget(n.target, t));
  const madeFrom = new Set(flows.map((f) => f.templateKey).filter((k): k is string => !!k));

  // 作成済みのテンプレートは「既存のフロー」側に出す（同じテンプレートのフローは組織に 1 つ）
  const templates = (Object.keys(FLOW_TEMPLATES) as FlowTemplateKey[])
    .filter((k) => !madeFrom.has(k))
    .map((k) => {
      const t = FLOW_TEMPLATES[k];
      const target: CanvasTarget = { kind: 'template', templateKey: k };
      return { key: `template:${k}`, label: clampLabel(t.name), icon: t.icon, target, onCanvas: on(target) };
    });

  const flowEntries = flows.map((f) => {
    const target: CanvasTarget = { kind: 'flow', flowId: f.id };
    // テンプレートのノードがそのフローを指している（書き換え前）なら、それも「置いてある」
    const viaTemplate = !!f.templateKey && on({ kind: 'template', templateKey: f.templateKey as FlowTemplateKey });
    return {
      key: `flow:${f.id}`,
      label: clampLabel(f.name),
      icon: isPageIcon(f.icon) ? f.icon : 'file-text',
      target,
      onCanvas: on(target) || viaTemplate,
    };
  });

  const screens = (Object.keys(CANVAS_SCREENS) as (keyof typeof CANVAS_SCREENS)[]).map((to) => {
    const target: CanvasTarget = { kind: 'link', to };
    return { key: `link:${to}`, label: CANVAS_SCREENS[to].label, icon: CANVAS_SCREENS[to].icon, target, onCanvas: on(target) };
  });

  return { templates, flows: flowEntries, screens };
}
