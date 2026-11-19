import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { useQueryClient } from '@tanstack/react-query';
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { CanvasLayout } from '@org-ai/shared-types';
import { Button } from '../ui';
import { usePrefersReducedMotion } from '../motion/springs';
import { AddMenu } from './AddMenu';
import { HomeNode, type HomeNodeData } from './HomeNode';
import { CANVAS_QUERY_KEY, apiErrorOf, saveCanvasLayout, type CanvasData } from './canvasApi';
import {
  addMenuSections,
  addNode,
  boardInteraction,
  connectNodes,
  layoutChanged,
  moveNode,
  removeEdge,
  removeNodes,
  type AddMenuEntry,
} from './canvasEdit';
import { canOpenTarget, canvasToList, isApprovalsTarget, resolveTarget, type BusinessRow } from './canvasToList';

import '@xyflow/react/dist/base.css';

/**
 * ホームキャンバス（PC。docs/design/canvas-home.md §3.2）。`CanvasHomePage` から**遅延ロード**だけで読む
 * （`@xyflow/react` をスマホと初回ロードに載せない。K20）。
 *
 * - 既定は閲覧モード: ノードは動かない・繋がらない・消えない。押すと開く。
 * - ADMIN 以上が「編集」を押すと、移動・接続・削除・追加が有効になり「保存」「やめる」が出る。
 *   保存は手動（K17）。版が違えば 409 CANVAS_CONFLICT（gateway の文言をそのまま 1 行出す）。
 * - 線は見た目だけ（K19）。矢印 1 つ・ラベルなし・アニメなし。
 */

const nodeTypes = { home: HomeNode };

interface Props {
  data: CanvasData;
  approvalsCount: number;
  /** 配置を編集できる（ADMIN 以上） */
  canEdit: boolean;
  /** テンプレートからフローを作れる（ADMIN 以上） */
  canCreate: boolean;
  onOpen: (row: BusinessRow) => void;
  pendingId?: string | null;
}

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const reduce = usePrefersReducedMotion();
  const duration = reduce ? 0 : 200;
  const cls =
    'flex h-8 w-8 items-center justify-center text-secondary transition-colors duration-fast hover:bg-sunken hover:text-primary';
  return (
    <div className="flex divide-x divide-border overflow-hidden rounded-sm border border-border bg-elevated">
      <button type="button" className={cls} aria-label="縮小" onClick={() => void zoomOut({ duration })}>
        <Minus size={14} aria-hidden="true" />
      </button>
      <button type="button" className={cls} aria-label="拡大" onClick={() => void zoomIn({ duration })}>
        <Plus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={cls}
        aria-label="全体を表示"
        onClick={() => void fitView({ padding: 0.2, maxZoom: 1, duration })}
      >
        <Maximize2 size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

/** ノードの数が変わったら全体が収まるよう合わせる（fitView プロパティは初回だけ効く） */
function FitOnCount({ count }: { count: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const raf = requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1 }));
    return () => cancelAnimationFrame(raf);
  }, [count, fitView]);
  return null;
}

function Board({ data, approvalsCount, canEdit, canCreate, onOpen, pendingId = null }: Props) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CanvasLayout | null>(null);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const editing = draft !== null;
  const layout = draft ?? data.layout;
  const interaction = boardInteraction(editing);

  const rows = useMemo(() => canvasToList(layout, data.flows), [layout, data.flows]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const activate = useCallback(
    (id: string) => {
      if (draft) {
        setSelectedNodes([id]);
        setSelectedEdges([]);
        return;
      }
      const row = rowById.get(id);
      // 未作成は MEMBER でも onOpen へ渡す（作らずに「まだ用意されていません」の 1 行を出す）
      if (row && row.target.kind !== 'missing') onOpen(row);
    },
    [draft, rowById, onOpen],
  );

  const nodes = useMemo<Node<HomeNodeData, 'home'>[]>(
    () =>
      layout.nodes.map((n) => {
        const target = resolveTarget(n, data.flows);
        return {
          id: n.id,
          type: 'home',
          position: { x: n.x, y: n.y },
          selected: editing && selectedNodes.includes(n.id),
          data: {
            label: n.label,
            icon: n.icon,
            target,
            count: isApprovalsTarget(target) ? approvalsCount : 0,
            editing,
            canOpen: canOpenTarget(target, canCreate),
            pending: pendingId === n.id,
            onActivate: activate,
          },
        };
      }),
    [layout, data.flows, editing, selectedNodes, approvalsCount, canCreate, pendingId, activate],
  );

  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((e) => {
        const id = `${e.from}->${e.to}`;
        return {
          id,
          source: e.from,
          target: e.to,
          selected: editing && selectedEdges.includes(id),
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        };
      }),
    [layout, editing, selectedEdges],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setDraft((cur) => {
      if (!cur) return cur;
      let next = cur;
      for (const c of changes) {
        if (c.type === 'position' && c.position) next = moveNode(next, c.id, c.position.x, c.position.y);
        if (c.type === 'remove') next = removeNodes(next, [c.id]);
      }
      return next;
    });
    const sel = changes.filter((c): c is Extract<NodeChange, { type: 'select' }> => c.type === 'select');
    if (sel.length > 0) {
      setSelectedNodes((cur) => {
        const s = new Set(cur);
        for (const c of sel) {
          if (c.selected) s.add(c.id);
          else s.delete(c.id);
        }
        return [...s];
      });
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setDraft((cur) => {
      if (!cur) return cur;
      let next = cur;
      for (const c of changes) {
        if (c.type !== 'remove') continue;
        const [from, to] = c.id.split('->');
        if (from && to) next = removeEdge(next, from, to);
      }
      return next;
    });
    const sel = changes.filter((c): c is Extract<EdgeChange, { type: 'select' }> => c.type === 'select');
    if (sel.length > 0) {
      setSelectedEdges((cur) => {
        const s = new Set(cur);
        for (const c of sel) {
          if (c.selected) s.add(c.id);
          else s.delete(c.id);
        }
        return [...s];
      });
    }
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    setDraft((cur) => (cur ? connectNodes(cur, c.source, c.target) : cur));
  }, []);

  const startEdit = () => {
    setMessage(null);
    setSelectedNodes([]);
    setSelectedEdges([]);
    setDraft(JSON.parse(JSON.stringify(data.layout)) as CanvasLayout);
  };

  const cancelEdit = () => {
    setDraft(null);
    setMenuOpen(false);
    setMessage(null);
    setSelectedNodes([]);
    setSelectedEdges([]);
  };

  const deleteSelected = () => {
    setDraft((cur) => {
      if (!cur) return cur;
      let next = removeNodes(cur, selectedNodes);
      for (const id of selectedEdges) {
        const [from, to] = id.split('->');
        if (from && to) next = removeEdge(next, from, to);
      }
      return next;
    });
    setSelectedNodes([]);
    setSelectedEdges([]);
  };

  const pick = (entry: AddMenuEntry) => {
    setMenuOpen(false);
    if (!draft) return;
    const res = addNode(draft, { label: entry.label, icon: entry.icon, target: entry.target });
    if (!res) {
      setMessage('これ以上置けません');
      return;
    }
    setDraft(res.layout);
    setSelectedNodes([res.id]);
    setSelectedEdges([]);
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await saveCanvasLayout(draft, data.version);
      await qc.invalidateQueries({ queryKey: CANVAS_QUERY_KEY });
      setDraft(null);
      setSelectedNodes([]);
      setSelectedEdges([]);
    } catch (e) {
      setMessage(apiErrorOf(e, '保存できませんでした。もう一度お試しください。').message);
    } finally {
      setSaving(false);
    }
  };

  /** 閲覧モードの矢印キー: 縦リストと同じ順で前後のノードへ（§3.6） */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-canvas-node]');
    if (!current) return;
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(current.dataset.canvasNode ?? '');
    const nextId = ids[i + step];
    if (i < 0 || !nextId) return;
    e.preventDefault();
    e.currentTarget.querySelector<HTMLElement>(`[data-canvas-node="${CSS.escape(nextId)}"]`)?.focus();
  };

  const dirty = draft ? layoutChanged(draft, data.layout) : false;
  const hasSelection = selectedNodes.length > 0 || selectedEdges.length > 0;

  return (
    <div>
      <div className="mb-2 flex min-h-9 items-center gap-2">
        <h2 className="text-sm font-bold text-text-muted">業務</h2>
        {message && (
          <p className="min-w-0 flex-1 truncate text-sm text-danger" role="alert">
            {message}
          </p>
        )}
        <div className="relative ml-auto flex items-center gap-2">
          {editing ? (
            <>
              <Button size="sm" variant="secondary" icon={<Plus size={13} />} onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen}>
                追加
              </Button>
              {hasSelection && (
                <Button size="sm" variant="ghost" onClick={deleteSelected}>
                  削除
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
                やめる
              </Button>
              <Button size="sm" variant={dirty ? 'primary' : 'secondary'} onClick={() => void save()} loading={saving} disabled={!dirty}>
                保存
              </Button>
              {menuOpen && draft && (
                <AddMenu sections={addMenuSections(draft, data.flows)} onPick={pick} onClose={() => setMenuOpen(false)} />
              )}
            </>
          ) : (
            canEdit && (
              <Button size="sm" variant="secondary" onClick={startEdit}>
                編集
              </Button>
            )
          )}
        </div>
      </div>

      <div
        className="home-canvas h-[clamp(360px,calc(100dvh-300px),640px)] rounded-md border border-border bg-canvas"
        data-editing={editing ? 'true' : 'false'}
        onKeyDown={onKeyDown}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          {...interaction}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.4}
          maxZoom={1.5}
          panOnDrag
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          aria-label="業務のキャンバス"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
          <Panel position="bottom-right">
            <ZoomControls />
          </Panel>
          <FitOnCount count={layout.nodes.length} />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function CanvasBoard(props: Props) {
  return (
    <ReactFlowProvider>
      <Board {...props} />
    </ReactFlowProvider>
  );
}
