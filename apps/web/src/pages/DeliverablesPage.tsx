import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { motion } from 'framer-motion';
import { Package, Sparkles, Share2, RefreshCw, Check } from 'lucide-react';
import { api } from '../services/api';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { DeliverableCard, type DeliverableData } from '../components/Deliverables/DeliverableCard';
import { FolderTabs } from '../components/Deliverables/FolderTabs';
import { useDeliverablesStore } from '../store/deliverablesStore';
import { DEPT_ACCENT, DEPT_LABEL } from '../constants/departments';

interface BackendTask {
  id: string;
  title: string;
  status: string;
  department: string;
  output: string | null;
  createdAt: string;
  logs?: { id: string; message: string; level: string; createdAt: string }[];
}

/** タスク出力から短い要約を取り出す（AI重要度づけの入力用）。 */
function summaryOf(output: string | null): string {
  if (!output) return '';
  try {
    const o = JSON.parse(output) as Record<string, unknown>;
    const s = o.summary ?? o.content ?? o.body ?? o.message ?? o.conclusion;
    if (typeof s === 'string') return s.slice(0, 200);
  } catch {
    /* not JSON */
  }
  return output.slice(0, 200);
}

/** タスク出力から共有用リンク（Google Doc等）を取り出す。 */
function linkOf(output: string | null): string | null {
  if (!output) return null;
  try {
    const o = JSON.parse(output) as Record<string, any>;
    const u = o.url ?? o.docUrl ?? o.webViewLink ?? o.spreadsheetUrl ?? o?.data?.url;
    if (typeof u === 'string' && u.startsWith('http')) return u;
  } catch {
    /* not JSON */
  }
  const m = output.match(/https?:\/\/[^\s"')]+/);
  return m ? m[0] : null;
}

/**
 * DeliverablesPage — organized deliverables board.
 * See DESIGN.md §11.4. Uses v2 primitives (Card/Button), DnD-kit for DnD.
 */
export default function DeliverablesPage() {
  const [tasks, setTasks] = useState<BackendTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ranking, setRanking] = useState(false);
  const [shared, setShared] = useState(false);

  const {
    folders,
    activeFolderId,
    setActiveFolder,
    reorderInFolder,
    moveToFolder,
    addItemIfMissing,
    importance,
    importanceOverride,
    setImportanceBatch,
    cycleImportance,
  } = useDeliverablesStore();

  // 実効重要度: 手動上書き > AI推定 > 既定(mid)
  const effImportance = useCallback(
    (id: string): 'high' | 'mid' | 'low' => importanceOverride[id] ?? importance[id] ?? 'mid',
    [importance, importanceOverride],
  );
  const IMP_RANK: Record<string, number> = { high: 0, mid: 1, low: 2 };

  // Fetch tasks
  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.get<{ success: boolean; data: BackendTask[] }>('/tasks');
        if (res.data.success) {
          const done = res.data.data.filter((t) => t.status === 'DONE' && t.output);
          setTasks(done);
          done.forEach((t) => addItemIfMissing(t.id));
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [addItemIfMissing]);

  // Build id -> task map
  const taskMap = useMemo(() => {
    const m = new Map<string, BackendTask>();
    tasks.forEach((t) => m.set(t.id, t));
    return m;
  }, [tasks]);

  // Active folder items
  const activeFolder = folders.find((f) => f.id === activeFolderId);
  const displayItems: DeliverableData[] = useMemo(() => {
    let base: BackendTask[];
    if (activeFolderId === 'all') {
      base = tasks;
    } else if (!activeFolder) {
      base = [];
    } else {
      base = activeFolder.itemIds
        .map((id) => taskMap.get(id))
        .filter((t): t is BackendTask => !!t);
    }
    // 重要度順（高→中→低）。同重要度は新しい順。
    const sorted = [...base].sort((a, b) => {
      const d = IMP_RANK[effImportance(a.id)] - IMP_RANK[effImportance(b.id)];
      if (d !== 0) return d;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return sorted.map((t) => ({
      id: t.id,
      title: t.title,
      department: t.department,
      output: t.output,
      createdAt: t.createdAt,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolderId, activeFolder, tasks, taskMap, effImportance]);

  // Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
  );

  const handleDragStart = useCallback((e: DragStartEvent) => {
    setActiveId(e.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = e;
      if (!over) return;

      const overId = over.id as string;
      const activeIdStr = active.id as string;

      // Dropped on folder tab
      if (overId.startsWith('folder-drop-')) {
        const targetFolder = overId.replace('folder-drop-', '');
        moveToFolder(activeIdStr, targetFolder);
        return;
      }

      // Reorder within current folder
      if (activeIdStr !== overId && activeFolderId !== 'all') {
        reorderInFolder(activeFolderId, activeIdStr, overId);
      }
    },
    [activeFolderId, reorderInFolder, moveToFolder],
  );

  const activeTask = activeId ? taskMap.get(activeId) : null;

  // Department stats
  const deptCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.department] = (counts[t.department] ?? 0) + 1;
    return counts;
  }, [tasks]);

  // AI 重要度づけ。返らなかった id は mid 固定（再問い合わせループ防止）。
  const rankItems = useCallback(
    async (items: BackendTask[]) => {
      if (items.length === 0) return;
      setRanking(true);
      const map: Record<string, 'high' | 'mid' | 'low'> = {};
      try {
        const res = await api.post<{ success: boolean; data: { rankings: { id: string; importance: string }[] } }>(
          '/deliverables/rank',
          { items: items.map((t) => ({ id: t.id, title: t.title, summary: summaryOf(t.output), department: t.department })) },
        );
        for (const r of res.data.data.rankings ?? []) {
          if (r.id && (r.importance === 'high' || r.importance === 'mid' || r.importance === 'low')) {
            map[r.id] = r.importance;
          }
        }
      } catch {
        /* fall through to mid */
      }
      for (const t of items) if (!(t.id in map)) map[t.id] = 'mid';
      setImportanceBatch(map);
      setRanking(false);
    },
    [setImportanceBatch],
  );

  // 未評価の成果物を自動で重要度づけ
  useEffect(() => {
    if (ranking) return;
    const unranked = tasks.filter((t) => !(t.id in importance) && !(t.id in importanceOverride));
    if (unranked.length > 0) void rankItems(unranked);
  }, [tasks, importance, importanceOverride, ranking, rankItems]);

  // 重要度順リストを書き出してコピー / OS共有
  const shareList = useCallback(async () => {
    const groups: Record<'high' | 'mid' | 'low', DeliverableData[]> = { high: [], mid: [], low: [] };
    for (const it of displayItems) groups[effImportance(it.id)].push(it);
    const head: Record<string, string> = { high: '🔴 重要度：高', mid: '🟡 重要度：中', low: '⚪ 重要度：低' };
    const lines: string[] = ['【FLOW 成果物リスト】（重要度順）'];
    (['high', 'mid', 'low'] as const).forEach((k) => {
      if (groups[k].length === 0) return;
      lines.push('', head[k]);
      groups[k].forEach((it, i) => {
        const link = linkOf(it.output);
        const dept = DEPT_LABEL[it.department] ?? it.department;
        lines.push(`${i + 1}. ${it.title}（${dept}）${link ? `\n   ${link}` : ''}`);
      });
    });
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be blocked */
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: 'FLOW 成果物リスト', text });
      } catch {
        /* user cancelled */
      }
    }
    setShared(true);
    setTimeout(() => setShared(false), 2200);
  }, [displayItems, effImportance]);

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 pb-6 pt-2">
      <div className="max-w-6xl mx-auto space-y-4">
        {/* Header */}
        <Card variant="thick" padding="lg" radius="xl">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-accent-soft flex items-center justify-center">
                <Package size={22} className="text-accent" />
              </div>
              <div>
                <h1 className="text-h2 font-bold text-primary">成果物</h1>
                <p className="text-sm text-secondary">
                  各部署のAIが作成した資料・データ・分析結果を整理・管理
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 text-xs text-secondary px-2.5 py-1.5 rounded-full bg-sunken border border-border tabular">
                <Sparkles size={13} className="text-accent" /> 全 {tasks.length} 件
              </span>
              <Button
                variant="glass"
                size="sm"
                onClick={() => void rankItems(tasks)}
                loading={ranking}
                icon={<RefreshCw size={13} />}
              >
                AIで重要度を再評価
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void shareList()}
                disabled={tasks.length === 0}
                icon={shared ? <Check size={13} /> : <Share2 size={13} />}
              >
                {shared ? 'コピーしました' : '重要度順で共有'}
              </Button>
            </div>
          </div>

          {/* Department stats strip */}
          {Object.keys(deptCounts).length > 0 && (
            <div className="mt-5 flex items-center gap-2 flex-wrap">
              {Object.entries(deptCounts).map(([dept, count]) => (
                <div
                  key={dept}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sunken border border-border"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: DEPT_ACCENT[dept] ?? DEPT_ACCENT.GENERAL }}
                  />
                  <span className="text-xs text-secondary">{dept}</span>
                  <span
                    className="text-xs font-bold tabular"
                    style={{ color: DEPT_ACCENT[dept] ?? DEPT_ACCENT.GENERAL }}
                  >
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Folder tabs */}
        <FolderTabs folders={folders} activeId={activeFolderId} onSelect={setActiveFolder} />

        {/* Grid with DnD */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={displayItems.map((i) => i.id)} strategy={rectSortingStrategy}>
            {loading ? (
              <Card variant="thin" className="text-center py-12">
                <p className="text-sm text-muted">読み込み中...</p>
              </Card>
            ) : displayItems.length === 0 ? (
              <EmptyState
                icon={<Package size={28} />}
                title={activeFolderId === 'all' ? 'まだ成果物がありません' : 'このフォルダは空です'}
                description="チャットからAIに依頼すると、ここに完了した成果物が集まります"
              />
            ) : (
              <motion.div
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
                layout
              >
                {displayItems.map((item) => (
                  <DeliverableCard
                    key={item.id}
                    item={item}
                    importance={effImportance(item.id)}
                    onCycleImportance={() => cycleImportance(item.id)}
                  />
                ))}
              </motion.div>
            )}
          </SortableContext>

          <DragOverlay>
            {activeTask ? (
              <div className="opacity-90 rotate-2 scale-105 pointer-events-none">
                <DeliverableCard
                  item={{
                    id: activeTask.id,
                    title: activeTask.title,
                    department: activeTask.department,
                    output: activeTask.output,
                    createdAt: activeTask.createdAt,
                  }}
                  importance={effImportance(activeTask.id)}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
