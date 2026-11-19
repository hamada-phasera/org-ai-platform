import type { CanvasLayout, CanvasNode, PageIcon } from '@org-ai/shared-types';

/**
 * ホームキャンバス（docs/design/canvas-home.md §3.2・§4.2）の純粋関数。
 * スマホの業務の縦リストと、PC のキーボード移動（矢印キーの順番）で共用する。
 *
 * ⚠️ zod の値も `@xyflow/react` も import しない（スマホの経路と初回ロードに載る。K20・K29）。
 */

/** `GET /api/canvas` の `flows`（見られるフローだけ。他組織・役割不足は入らない） */
export interface CanvasFlowSummary {
  id: string;
  slug: string;
  name: string;
  icon: string;
  enabled: boolean;
  templateKey: string | null;
}

/**
 * ノードを押したときの行き先（§3.3）。
 * - `flow`     フローがある → `/flows/:id`
 * - `template` 未作成 → ADMIN 以上が押すとテンプレートから作る
 * - `link`     既存の画面
 * - `missing`  指すフローが消えた・見えない（手作りのフロー。作り直す元が無い）→「未作成」で押せない
 */
export type ResolvedTarget =
  | { kind: 'flow'; flowId: string; enabled: boolean }
  | { kind: 'template'; templateKey: string }
  | { kind: 'link'; to: string }
  | { kind: 'missing' };

export function resolveTarget(node: Pick<CanvasNode, 'target'>, flows: readonly CanvasFlowSummary[]): ResolvedTarget {
  const t = node.target;
  if (t.kind === 'link') return { kind: 'link', to: t.to };
  if (t.kind === 'flow') {
    const f = flows.find((x) => x.id === t.flowId);
    return f ? { kind: 'flow', flowId: f.id, enabled: f.enabled } : { kind: 'missing' };
  }
  // テンプレートのノード。キャンバスの書き換えだけ諦めた作成（K47）でもフローはあるので、それを開く
  const f = flows.find((x) => x.templateKey === t.templateKey);
  return f ? { kind: 'flow', flowId: f.id, enabled: f.enabled } : { kind: 'template', templateKey: t.templateKey };
}

/** 「未作成」の印を出すか */
export function isUncreated(target: ResolvedTarget): boolean {
  return target.kind === 'template' || target.kind === 'missing';
}

/** 押せるか。テンプレートの作成は ADMIN 以上だけ。消えたフローは誰も押せない */
export function canOpenTarget(target: ResolvedTarget, canCreate: boolean): boolean {
  if (target.kind === 'missing') return false;
  if (target.kind === 'template') return canCreate;
  return true;
}

/** 承認件数の印を出すノード（受信の承認タブ）。数字はこれだけ（DESIGN.md §4） */
export function isApprovalsTarget(target: ResolvedTarget): boolean {
  return target.kind === 'link' && target.to === '/inbox?tab=approvals';
}

export interface BusinessRow {
  id: string;
  label: string;
  icon: PageIcon;
  target: ResolvedTarget;
  /** 出る線の先のラベル（最大 2 つ） */
  next: string[];
  /** 3 つ目以降がある（「ほか」） */
  nextMore: boolean;
}

/** 配置の順（上 → 下、左 → 右）。同じ座標は配列の順 */
function byPosition(a: CanvasNode, b: CanvasNode): number {
  return a.y - b.y || a.x - b.x;
}

/**
 * 縦リストの並び（§4.2）。
 * 線をたどった順（トポロジカル順。同順位は上 → 下、左 → 右）。線の無いノードは末尾。
 * 循環があれば（業務の地図は循環しうる）、線のあるノードを配置順に並べる。
 */
export function orderCanvasNodes(layout: CanvasLayout): CanvasNode[] {
  const nodes = [...layout.nodes].sort(byPosition);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = layout.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const connected = nodes.filter((n) => linked.has(n.id));
  const isolated = nodes.filter((n) => !linked.has(n.id));

  const rank = new Map(connected.map((n, i) => [n.id, i]));
  const indeg = new Map(connected.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(connected.map((n) => [n.id, []]));
  for (const e of edges) {
    out.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const byId = new Map(connected.map((n) => [n.id, n]));
  // 段ごとに進める（Kahn 法の層）。同じ段（同順位）の中は配置順
  let layer = connected.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: CanvasNode[] = [];
  while (layer.length > 0) {
    layer.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    const nextLayer: string[] = [];
    for (const id of layer) {
      order.push(byId.get(id) as CanvasNode);
      for (const to of out.get(id) ?? []) {
        const d = (indeg.get(to) ?? 0) - 1;
        indeg.set(to, d);
        if (d === 0) nextLayer.push(to);
      }
    }
    layer = nextLayer;
  }
  const head = order.length === connected.length ? order : connected;
  return [...head, ...isolated];
}

/** 業務の縦リスト（§4.2）。スマホのホームと、PC のキーボード移動の順番 */
export function canvasToList(layout: CanvasLayout, flows: readonly CanvasFlowSummary[]): BusinessRow[] {
  const ordered = orderCanvasNodes(layout);
  const pos = new Map(ordered.map((n, i) => [n.id, i]));
  const labelOf = new Map(layout.nodes.map((n) => [n.id, n.label]));
  return ordered.map((n) => {
    const targets = [...new Set(layout.edges.filter((e) => e.from === n.id && e.to !== n.id).map((e) => e.to))]
      .filter((id) => labelOf.has(id))
      .sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
    return {
      id: n.id,
      label: n.label,
      icon: n.icon,
      target: resolveTarget(n, flows),
      next: targets.slice(0, 2).map((id) => labelOf.get(id) as string),
      nextMore: targets.length > 2,
    };
  });
}

/** 「次: 〇〇」の中身（無ければ null＝2 行目を出さない） */
export function nextText(row: Pick<BusinessRow, 'next' | 'nextMore'>): string | null {
  if (row.next.length === 0) return null;
  return `${row.next.join('・')}${row.nextMore ? ' ほか' : ''}`;
}
