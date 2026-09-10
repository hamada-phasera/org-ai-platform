import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, HardHat, Plus } from 'lucide-react';
import { api } from '../../services/api';
import { Button, Card, EmptyState, Input, SkeletonList } from '../ui';
import {
  COST_CATEGORIES,
  COST_CATEGORY_LABEL,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABEL,
  marginTone,
  percent,
  yen,
  yenShort,
  type CostCategory,
  type ProjectRow,
  type ProjectStatus,
} from './types';

/**
 * 工事台帳。
 *
 * 一般の経費一覧と決定的に違うのは、**行が「現場」で、原価が4分類に割れている**こと。
 * 中小建設業の一番の痛点は「月末まで現場ごとの利益が分からない」なので、
 * 一覧の時点で粗利と粗利率を出し、予算超過の分類を名指しする。
 */

const TONE_CLASS: Record<'danger' | 'warning' | 'normal', string> = {
  danger: 'text-danger',
  warning: 'text-warning',
  normal: 'text-primary',
};

/** 予算 vs 実績の横棒。予算を超えた分は danger で描く。 */
function BudgetBar({ budget, actual }: { budget: number; actual: number }) {
  // 予算が 0 のときは比率を作れない。実績があるなら「予算なし」として満杯に描く
  const ratio = budget > 0 ? actual / budget : actual > 0 ? 1 : 0;
  const over = budget > 0 && actual > budget;
  const width = Math.min(ratio, 1) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
      <div
        className={`h-full rounded-full ${over ? 'bg-danger' : 'bg-accent'}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function ProjectDetail({ project }: { project: ProjectRow }) {
  return (
    <div className="space-y-3 border-t border-hairline bg-sunken px-4 py-4">
      <p className="text-micro font-semibold uppercase tracking-[0.15em] text-muted">
        実行予算 vs 実績（4分類）
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {COST_CATEGORIES.map((c: CostCategory) => {
          const b = project.budget[c];
          const a = project.actual[c];
          const over = b > 0 && a > b;
          return (
            <div key={c} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-bold text-primary">{COST_CATEGORY_LABEL[c]}</span>
                <span className={`tabular text-xs ${over ? 'text-danger' : 'text-secondary'}`}>
                  {yen(a)}
                  <span className="text-text-muted"> / {b > 0 ? yen(b) : '予算未設定'}</span>
                </span>
              </div>
              <BudgetBar budget={b} actual={a} />
              {over && (
                <p className="text-micro text-danger">
                  予算を {yen(a - b)} 超過しています
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-micro text-text-muted">
        金額はすべて税抜です。消費税は預り金であって利益ではないため、粗利は税抜どうしで計算しています。
      </p>
    </div>
  );
}

function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ code: '', name: '', client: '', contractAmount: '' });
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post('/accounting/projects', {
        code: form.code.trim(),
        name: form.name.trim(),
        client: form.client.trim() || null,
        contractAmount: Number(form.contractAmount) || 0,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting-projects'] });
      qc.invalidateQueries({ queryKey: ['accounting-summary'] });
      onDone();
    },
    onError: (err) => {
      const data = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data;
      setError(data?.error?.message ?? '登録できませんでした');
    },
  });

  return (
    <Card variant="regular" padding="md" radius="2xl" className="space-y-3">
      <div className="grid gap-2.5 sm:grid-cols-4">
        <Input
          size="sm"
          placeholder="工事番号 (例 K-001)"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />
        <Input
          size="sm"
          placeholder="工事名"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Input
          size="sm"
          placeholder="発注者"
          value={form.client}
          onChange={(e) => setForm({ ...form, client: e.target.value })}
        />
        <Input
          size="sm"
          type="number"
          inputMode="numeric"
          placeholder="請負金額（税抜）"
          value={form.contractAmount}
          onChange={(e) => setForm({ ...form, contractAmount: e.target.value })}
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          loading={mut.isPending}
          disabled={!form.code.trim() || !form.name.trim()}
          onClick={() => {
            setError(null);
            mut.mutate();
          }}
        >
          工事を登録
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          やめる
        </Button>
        <p className="ml-auto text-micro text-text-muted">
          実行予算はあとから設定できます。まず現場を作ってしまうのが早いです。
        </p>
      </div>
    </Card>
  );
}

export function ProjectLedger() {
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'ALL'>('ALL');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const q = useQuery({
    queryKey: ['accounting-projects', statusFilter],
    queryFn: async () => {
      const suffix = statusFilter === 'ALL' ? '' : `?status=${statusFilter}`;
      const res = await api.get<{ success: boolean; data: ProjectRow[] }>(
        `/accounting/projects${suffix}`,
      );
      return res.data.data;
    },
  });

  const projects = q.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ProjectStatus | 'ALL')}
          className="rounded-sm border border-border bg-elevated px-3 py-2 text-xs text-primary"
          aria-label="工事の状態で絞り込む"
        >
          <option value="ALL">すべての工事</option>
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PROJECT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="tabular text-[11px] text-muted">{projects.length} 件</span>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          className="ml-auto"
          onClick={() => setCreating((v) => !v)}
        >
          工事を追加
        </Button>
      </div>

      {creating && <CreateProjectForm onDone={() => setCreating(false)} />}

      {q.isLoading ? (
        <SkeletonList count={3} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<HardHat size={22} />}
          title="工事がまだありません"
          description="工事（現場）を登録すると、材料費・労務費・外注費・経費の4分類で原価が積み上がり、現場ごとの粗利がその場で出ます。"
          action={{ label: '工事を追加', onClick: () => setCreating(true) }}
        />
      ) : (
        <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-sunken">
                <tr>
                  {['工事', '状態', '請負金額', '実行予算', '実績原価', '粗利', '進捗', ''].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3.5 text-left text-micro font-semibold uppercase tracking-[0.15em] text-muted"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {projects.map((p) => {
                  const open = openId === p.id;
                  const tone = marginTone(p.grossMarginRate);
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className="cursor-pointer transition-colors hover:bg-sunken"
                        onClick={() => setOpenId(open ? null : p.id)}
                      >
                        <td className="px-4 py-3.5">
                          <p className="text-xs font-bold text-primary">{p.name}</p>
                          <p className="font-mono text-micro text-text-muted">
                            {p.code}
                            {p.client && ` · ${p.client}`}
                          </p>
                        </td>
                        <td className="px-4 py-3.5">
                          <span className="rounded-full bg-sunken px-2 py-0.5 text-micro font-bold text-secondary">
                            {PROJECT_STATUS_LABEL[p.status as ProjectStatus] ?? p.status}
                          </span>
                        </td>
                        <td className="tabular px-4 py-3.5 text-xs text-secondary">
                          {yenShort(p.contractAmount)}
                        </td>
                        <td className="tabular px-4 py-3.5 text-xs text-secondary">
                          {p.budgetTotal > 0 ? yenShort(p.budgetTotal) : '—'}
                        </td>
                        <td className="px-4 py-3.5">
                          <p className="tabular text-xs text-secondary">{yenShort(p.actualTotal)}</p>
                          {p.overBudget.length > 0 && (
                            <p className="text-micro text-danger">
                              {p.overBudget.map((c) => COST_CATEGORY_LABEL[c]).join('・')}が超過
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          <p className={`tabular text-xs font-bold ${TONE_CLASS[tone]}`}>
                            {yenShort(p.grossProfit)}
                          </p>
                          <p className={`tabular text-micro ${TONE_CLASS[tone]}`}>
                            {percent(p.grossMarginRate)}
                          </p>
                        </td>
                        <td className="tabular px-4 py-3.5 text-xs text-secondary">{p.progressRate}%</td>
                        <td className="px-4 py-3.5">
                          <ChevronDown
                            size={14}
                            className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`}
                            aria-hidden="true"
                          />
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={8} className="p-0">
                            <ProjectDetail project={p} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

export default ProjectLedger;
