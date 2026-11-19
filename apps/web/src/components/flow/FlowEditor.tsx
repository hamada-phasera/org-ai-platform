import { Suspense, lazy, useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play, Plus } from 'lucide-react';
import { FLOW_PARTS, flowDefinitionSchema, topoOrder, type FlowDefinition, type FlowNode, type FlowNodeType } from '@org-ai/shared-types';
import { Button, Spinner } from '../ui';

/* 出力ビルダー（@dnd-kit とブロックの描画）は「出力」を開いたときだけ読む */
const OutputBuilder = lazy(() => import('./OutputBuilder'));
import { LiquidTabs } from '../motion/LiquidTabs';
import { FlowCanvasNode, FlowEdgeView, type FlowEdgeData, type FlowNodeData } from './FlowCanvasNode';
import { FlowSettingsPanel, NodePanel } from './NodePanel';
import { NodeTypeMenu } from './NodeTypeMenu';
import { RunForm, fieldErrorsOf } from './RunForm';
import { RunHistory } from './RunHistory';
import { RunStatusLine, useRunAction } from './useRunAction';
import {
  apiErrorOf,
  flowKey,
  patchFlow,
  runBlockReason,
  saveFlow,
  useFlowRunner,
  useFlowRuns,
  type FlowDetail,
  type PartInfo,
} from './flowApi';
import {
  addFlowNode,
  addableTypes,
  connectFlowNodes,
  defaultNode,
  flowChanged,
  issuesByNode,
  normalizeDefinition,
  normalizeLayout,
  removeFlowEdge,
  removeFlowNodes,
  replaceNode,
  stepRows,
  type FlowIssueLike,
  type FlowLayoutMap,
} from './flowModel';

import '@xyflow/react/dist/base.css';

/**
 * フロー画面（PC。docs/design/canvas-home.md §3.4）。`FlowPage` から**遅延ロード**だけで読む
 * （`@xyflow/react` と zod のスキーマをスマホと初回ロードに載せない。K20・K29）。
 *
 * - ノードの追加（左下の「＋」・線の途中の「＋」）・削除・接続・設定（右パネル）。保存は手動（K17）。版の衝突は 409 の 1 行。
 * - 保存の前に同じスキーマ（flowDefinitionSchema）で検証し、該当ノードに danger の点＋右パネルに 1 行。gateway の 400 の issues も同じ形で出す（K48）。
 * - 未保存のまま実行はできない（保存を促す）。実行・履歴の 1 回はキャンバスの各ノードに状態の点を重ねる。
 * - 部品の未接続・上位プランはノードと右パネルに出す。運営にだけ「n8n で開く」。
 */

const nodeTypes = { step: FlowCanvasNode };
const edgeTypes = { step: FlowEdgeView };

type Tab = 'steps' | 'output' | 'history';

interface Props {
  flow: FlowDetail;
  parts: PartInfo[];
}

function round(layout: FlowLayoutMap): FlowLayoutMap {
  return Object.fromEntries(Object.entries(layout).map(([k, p]) => [k, { x: Math.round(p.x), y: Math.round(p.y) }]));
}

/** 位置の無いノードは縦 1 本に並べる（古い行・テンプレートと同じ置き方） */
function withPositions(def: FlowDefinition, layout: FlowLayoutMap): FlowLayoutMap {
  const out = { ...layout };
  const order = topoOrder(def) ?? def.nodes.map((n) => n.id);
  order.forEach((id, i) => {
    if (!out[id]) out[id] = { x: 0, y: i * 140 };
  });
  return out;
}

/** 画面での検証（gateway と同じスキーマ）。問題の場所だけ（値は入れない） */
export function validateDefinition(def: FlowDefinition): FlowIssueLike[] {
  const r = flowDefinitionSchema.safeParse(def);
  return r.success ? [] : r.error.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message }));
}

function Editor({ flow, parts }: Props) {
  const qc = useQueryClient();
  const saved = useMemo(() => {
    const def = normalizeDefinition(flow.definition);
    return { def, layout: withPositions(def, normalizeLayout(flow.layout)), name: flow.name };
  }, [flow]);
  const [work, setWork] = useState(saved);
  const [selected, setSelected] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  // 出力ビルダーは ADMIN 以上・PC だけ（§3.1。`/flows/:id?view=output`）
  const [tab, setTabState] = useState<Tab>(() => (flow.canEdit && params.get('view') === 'output' ? 'output' : 'steps'));
  const setTab = useCallback(
    (t: Tab) => {
      setTabState(t);
      const next = new URLSearchParams(params);
      if (t === 'output') next.set('view', 'output');
      else next.delete('view');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const [menu, setMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<FlowIssueLike[]>([]);
  const [checked, setChecked] = useState(!flow.valid);
  const [enabledBusy, setEnabledBusy] = useState(false);
  const [minRole, setMinRole] = useState(flow.minRole);

  const runner = useFlowRunner(flow.id);
  const runs = useFlowRuns(flow.id, tab === 'history');
  const action = useRunAction(saved.def, runner);
  const canEdit = flow.canEdit;
  // 出力キー・差し込みの候補はコードのカタログ（gateway の検証と同じもの）。表示用の接続状態は parts（API）
  const partSpecs = FLOW_PARTS;

  const dirty = flowChanged(work, saved) || minRole !== flow.minRole;
  const clientIssues = useMemo(() => (checked ? validateDefinition(work.def) : []), [checked, work.def]);
  const issues = useMemo(() => issuesByNode(work.def, [...clientIssues, ...serverIssues]), [work.def, clientIssues, serverIssues]);
  const blocked = runBlockReason({ dirty, enabled: flow.enabled, usage: flow.usage, valid: flow.valid });
  const steps = runner.run?.steps ?? null;
  const partOf = useCallback((key: string) => parts.find((p) => p.key === key), [parts]);

  const update = useCallback((fn: (w: typeof saved) => typeof saved) => {
    setServerIssues([]);
    setWork((w) => fn(w));
  }, []);

  const activate = useCallback((id: string) => {
    setSelected(id);
    setTab('steps');
  }, []);

  const insertOnEdge = useCallback(
    (from: string, to: string, when?: 'yes' | 'no') => {
      // 線の途中の「＋」: AI を挟む（最もよく使う型。種類は右パネルで変えられる）
      const res = addFlowNode(work.def, work.layout, defaultNode(work.def, 'ai', partSpecs), { onEdge: when ? { from, to, when } : { from, to } });
      if (!res) {
        setMessage('これ以上置けません');
        return;
      }
      setServerIssues([]);
      setWork((w) => ({ ...w, def: res.def, layout: res.layout }));
      setSelected(res.id);
    },
    [work, partSpecs],
  );

  const nodes = useMemo<Node<FlowNodeData, 'step'>[]>(
    () =>
      work.def.nodes.map((n) => {
        let notice: string | undefined;
        if (n.type === 'part') {
          const p = partOf(n.config.part);
          notice = !p ? undefined : !p.allowed ? '上位' : p.connection !== 'ok' ? '未接続' : undefined;
        }
        return {
          id: n.id,
          type: 'step',
          position: work.layout[n.id] ?? { x: 0, y: 0 },
          selected: n.id === selected,
          data: {
            label: n.label,
            type: n.type,
            status: steps?.[n.id]?.status,
            issue: issues.nodes[n.id]?.[0],
            notice,
            editable: canEdit,
            onActivate: activate,
          },
        };
      }),
    [work, selected, steps, issues, canEdit, activate, partOf],
  );

  const edges = useMemo<Edge<FlowEdgeData, 'step'>[]>(
    () =>
      work.def.edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        type: 'step',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        data: { when: e.when, editable: canEdit, onInsert: insertOnEdge },
      })),
    [work.def.edges, canEdit, insertOnEdge],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!canEdit) return;
      const removed = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
      const moved = changes.filter((c): c is Extract<NodeChange, { type: 'position' }> => c.type === 'position' && !!c.position);
      if (removed.length === 0 && moved.length === 0) return;
      update((w) => {
        let layout = { ...w.layout };
        for (const c of moved) if (c.position) layout[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
        let def = w.def;
        if (removed.length) ({ def, layout } = removeFlowNodes(def, layout, removed));
        return { ...w, def, layout };
      });
      if (removed.includes(selected ?? '')) setSelected(null);
    },
    [canEdit, selected, update],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!canEdit) return;
      const removed = changes.filter((c) => c.type === 'remove');
      if (removed.length === 0) return;
      update((w) => {
        let def = w.def;
        for (const c of removed) {
          const [from, to] = c.id.split('->');
          if (from && to) def = removeFlowEdge(def, from, to);
        }
        return { ...w, def };
      });
    },
    [canEdit, update],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || !c.source || !c.target) return;
      update((w) => ({ ...w, def: connectFlowNodes(w.def, c.source, c.target) }));
    },
    [canEdit, update],
  );

  const addType = (t: FlowNodeType) => {
    setMenu(false);
    const order = topoOrder(work.def) ?? work.def.nodes.map((n) => n.id);
    const after = selected ?? order[order.length - 1];
    const res = addFlowNode(work.def, work.layout, defaultNode(work.def, t, partSpecs), after ? { after } : {});
    if (!res) {
      setMessage('これ以上置けません');
      return;
    }
    update((w) => ({ ...w, def: res.def, layout: res.layout }));
    setSelected(res.id);
  };

  const deleteNode = (id: string) => {
    update((w) => {
      const r = removeFlowNodes(w.def, w.layout, [id]);
      return { ...w, def: r.def, layout: r.layout };
    });
    setSelected(null);
  };

  const save = async () => {
    if (!dirty || saving) return;
    setMessage(null);
    setChecked(true);
    const found = validateDefinition(work.def);
    if (found.length > 0) {
      setMessage(`直すところがあります（${found.length} か所）`);
      return;
    }
    const name = work.name.trim();
    if (!name) {
      setMessage('名前を入れてください');
      return;
    }
    setSaving(true);
    try {
      await saveFlow(flow.id, {
        definition: work.def,
        layout: round(work.layout),
        baseVersion: flow.version,
        ...(name !== flow.name ? { name } : {}),
        ...(minRole !== flow.minRole ? { minRole } : {}),
      });
      setServerIssues([]);
      setWork((w) => ({ ...w, name, layout: round(w.layout) }));
      await qc.invalidateQueries({ queryKey: flowKey(flow.id) });
    } catch (e) {
      const err = apiErrorOf(e, '保存できませんでした。もう一度お試しください。');
      setServerIssues(err.issues);
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    setEnabledBusy(true);
    try {
      await patchFlow(flow.id, { enabled: !flow.enabled });
      await qc.invalidateQueries({ queryKey: flowKey(flow.id) });
    } catch (e) {
      setMessage(apiErrorOf(e, '変更できませんでした。').message);
    } finally {
      setEnabledBusy(false);
    }
  };

  /** 矢印キー: ステップの縦リストと同じ順で前後のノードへ（§3.6） */
  const rowsOrder = useMemo(() => stepRows(work.def).map((r) => r.node.id), [work.def]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-flow-node]');
    if (!current) return;
    const i = rowsOrder.indexOf(current.dataset.flowNode ?? '');
    const nextId = rowsOrder[i + step];
    if (i < 0 || !nextId) return;
    e.preventDefault();
    e.currentTarget.querySelector<HTMLElement>(`[data-flow-node="${CSS.escape(nextId)}"]`)?.focus();
  };

  const node: FlowNode | undefined = work.def.nodes.find((n) => n.id === selected);
  const types = addableTypes(work.def);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm font-bold text-secondary hover:text-primary">
          <ArrowLeft size={15} aria-hidden="true" />
          ホーム
        </Link>
        {canEdit ? (
          <>
            <label htmlFor="flow-name" className="sr-only">
              フロー名
            </label>
            <input
              id="flow-name"
              value={work.name}
              maxLength={24}
              onChange={(e) => update((w) => ({ ...w, name: e.target.value }))}
              className="w-56 min-w-0 rounded-sm border border-transparent bg-transparent px-2 py-1 text-h3 font-extrabold text-primary outline-none hover:border-border focus:border-accent"
            />
          </>
        ) : (
          <h1 className="min-w-0 truncate text-h3 font-extrabold">{flow.name}</h1>
        )}
        <div className="mx-auto">
          <LiquidTabs<Tab>
            id="flow-tabs"
            size="sm"
            label="フロー画面の表示切り替え"
            items={[
              { value: 'steps', label: '手順' },
              ...(canEdit ? [{ value: 'output' as const, label: '出力' }] : []),
              { value: 'history', label: '履歴' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        {canEdit && tab !== 'output' && (
          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={saving} onClick={() => void save()}>
            保存
          </Button>
        )}
        {tab !== 'output' && (
        <Button size="sm" variant={dirty ? 'secondary' : 'primary'} icon={<Play size={12} />} disabled={!!blocked} loading={runner.busy} onClick={action.onRun} title={blocked ?? undefined}>
          実行
        </Button>
        )}
      </div>

      <div className="px-5" aria-live="polite">
        {(message || issues.general[0]) && <p className="pt-2 text-sm text-danger">{message ?? issues.general[0]}</p>}
        {!message && blocked && <p className="pt-2 text-sm text-text-muted">{blocked}</p>}
        <RunStatusLine run={runner.run} error={action.formOpen ? null : runner.error} onClear={runner.clear} />
      </div>

      {tab === 'output' ? (
        <Suspense
          fallback={
            <div className="flex flex-1 justify-center py-20" aria-busy="true">
              <Spinner />
            </div>
          }
        >
          {dirty && <p className="px-5 pt-2 text-sm text-text-muted">手順の変更は、保存してから出力に反映されます</p>}
          <OutputBuilder flow={flow} />
        </Suspense>
      ) : (
      <div className="flex min-h-0 flex-1">
        <div className="home-canvas relative min-w-0 flex-1 bg-canvas" data-editing={canEdit ? 'true' : 'false'} onKeyDown={onKeyDown}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneClick={() => setSelected(null)}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            elementsSelectable
            nodesFocusable={false}
            edgesFocusable={canEdit}
            deleteKeyCode={canEdit ? ['Delete', 'Backspace'] : null}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.4}
            maxZoom={1.5}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            aria-label="手順のキャンバス"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
            {canEdit && types.length > 0 && (
              <Panel position="bottom-left">
                <div className="relative">
                  {menu && <NodeTypeMenu types={types} onPick={addType} onClose={() => setMenu(false)} className="absolute bottom-full left-0 mb-2" />}
                  <button
                    type="button"
                    aria-label="ノードを追加"
                    aria-expanded={menu}
                    onClick={() => setMenu((v) => !v)}
                    className="flex h-9 w-9 items-center justify-center rounded-sm border border-border bg-elevated text-secondary hover:border-border-strong hover:text-primary"
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-border bg-elevated" aria-label={tab === 'history' ? '履歴' : '設定'}>
          {tab === 'history' ? (
            <div className="px-3 py-3">
              <RunHistory
                runs={runs.data}
                loading={runs.isLoading}
                error={runs.isError}
                selectedId={runner.run?.id ?? null}
                onRetry={() => void runs.refetch()}
                onSelect={(runId) => void runner.show(runId)}
              />
            </div>
          ) : node ? (
            <NodePanel
              key={node.id}
              node={node}
              def={work.def}
              parts={parts}
              canEdit={canEdit}
              issues={issues.nodes[node.id] ?? []}
              step={steps?.[node.id]}
              onChange={(n) => update((w) => ({ ...w, def: replaceNode(w.def, n) }))}
              onDelete={() => deleteNode(node.id)}
            />
          ) : (
            <FlowSettingsPanel
              minRole={minRole}
              enabled={flow.enabled}
              canEdit={canEdit}
              onMinRole={setMinRole}
              onToggleEnabled={() => void toggleEnabled()}
              enabledBusy={enabledBusy}
            />
          )}
        </aside>
      </div>
      )}

      {action.formOpen && action.fields && (
        <RunForm
          title={flow.name}
          fields={action.fields}
          busy={runner.busy}
          serverErrors={fieldErrorsOf(runner.error?.code === 'VALIDATION_ERROR' ? runner.error.issues : [])}
          message={runner.error && runner.error.code !== 'VALIDATION_ERROR' ? runner.error.message : null}
          onSubmit={(input) => void action.submit(input)}
          onClose={action.closeForm}
        />
      )}
    </div>
  );
}

export default function FlowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}
