import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Inbox, Plus, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { Button, Card, EmptyState, Input, SkeletonList } from '../ui';
import {
  COST_CATEGORIES,
  COST_CATEGORY_LABEL,
  SOURCE_LABEL,
  yen,
  type CostCategory,
  type CostRow,
  type ProjectRow,
  type VendorRow,
} from './types';

/**
 * 原価明細の確認画面。
 *
 * チャットや LINE から入ってきた明細は DRAFT（AI が読んだが人が未確認）で積まれる。
 * **AI が読んだ数字をそのまま台帳の確定値にしない**のがこの画面の存在理由。
 * 外部送信に承認を挟むのと同じ考え方を、金額に対しても適用している。
 */

function AddCostForm({
  projects,
  vendors,
  onDone,
}: {
  projects: ProjectRow[];
  vendors: VendorRow[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    projectId: projects[0]?.id ?? '',
    vendorId: '',
    incurredOn: today,
    category: 'MATERIAL' as CostCategory,
    amountIncludingTax: '',
    description: '',
  });
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post('/accounting/costs', {
        projectId: form.projectId,
        vendorId: form.vendorId || null,
        incurredOn: form.incurredOn,
        category: form.category,
        // 手入力の入口は税込に統一する。領収書に書いてある数字をそのまま打てるように
        amountIncludingTax: Number(form.amountIncludingTax) || 0,
        description: form.description.trim() || null,
        source: 'MANUAL',
        status: 'CONFIRMED', // 人が自分で打った数字は確認済み
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting-costs'] });
      qc.invalidateQueries({ queryKey: ['accounting-projects'] });
      qc.invalidateQueries({ queryKey: ['accounting-summary'] });
      onDone();
    },
    onError: (err) => {
      const data = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data;
      setError(data?.error?.message ?? '登録できませんでした');
    },
  });

  const selectClass = 'rounded-sm border border-border bg-elevated px-3 py-2 text-xs text-primary';

  return (
    <Card variant="regular" padding="md" radius="2xl" className="space-y-3">
      <div className="grid gap-2.5 sm:grid-cols-3">
        <select
          className={selectClass}
          value={form.projectId}
          onChange={(e) => setForm({ ...form, projectId: e.target.value })}
          aria-label="工事"
        >
          <option value="">工事を選ぶ</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} {p.name}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value as CostCategory })}
          aria-label="費目"
        >
          {COST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {COST_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={form.vendorId}
          onChange={(e) => setForm({ ...form, vendorId: e.target.value })}
          aria-label="取引先"
        >
          <option value="">取引先なし</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.invoiceRegistered ? '' : '（インボイス未登録）'}
            </option>
          ))}
        </select>
        <Input
          size="sm"
          type="date"
          value={form.incurredOn}
          onChange={(e) => setForm({ ...form, incurredOn: e.target.value })}
          aria-label="発生日"
        />
        <Input
          size="sm"
          type="number"
          inputMode="numeric"
          placeholder="金額（税込）"
          value={form.amountIncludingTax}
          onChange={(e) => setForm({ ...form, amountIncludingTax: e.target.value })}
        />
        <Input
          size="sm"
          placeholder="摘要（木材、〇〇商店 など）"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          loading={mut.isPending}
          disabled={!form.projectId || !form.amountIncludingTax}
          onClick={() => {
            setError(null);
            mut.mutate();
          }}
        >
          原価を追加
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          やめる
        </Button>
        <p className="ml-auto text-micro text-text-muted">
          領収書のとおり税込で入力してください。台帳側では税抜と消費税に分けて持ちます。
        </p>
      </div>
    </Card>
  );
}

export function CostApproval() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const costsQ = useQuery({
    queryKey: ['accounting-costs', showAll],
    queryFn: async () => {
      const suffix = showAll ? '' : '?status=DRAFT';
      const res = await api.get<{ success: boolean; data: CostRow[] }>(`/accounting/costs${suffix}`);
      return res.data.data;
    },
  });

  const projectsQ = useQuery({
    queryKey: ['accounting-projects', 'ALL'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: ProjectRow[] }>('/accounting/projects');
      return res.data.data;
    },
  });

  const vendorsQ = useQuery({
    queryKey: ['accounting-vendors'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: VendorRow[] }>('/accounting/vendors');
      return res.data.data;
    },
  });

  const confirmMut = useMutation({
    mutationFn: (ids: string[]) => api.post('/accounting/costs/confirm', { ids }),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['accounting-costs'] });
      qc.invalidateQueries({ queryKey: ['accounting-projects'] });
      qc.invalidateQueries({ queryKey: ['accounting-summary'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/accounting/costs/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting-costs'] });
      qc.invalidateQueries({ queryKey: ['accounting-projects'] });
      qc.invalidateQueries({ queryKey: ['accounting-summary'] });
    },
  });

  const costs = costsQ.data ?? [];
  const draftCount = useMemo(() => costs.filter((c) => c.status === 'DRAFT').length, [costs]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectableIds = costs.filter((c) => c.status === 'DRAFT').map((c) => c.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  return (
    <div className="space-y-4">
      <Card variant="thin" padding="md" radius="2xl">
        <p className="text-xs leading-relaxed text-secondary">
          チャットや LINE から入ってきた原価は、
          <b className="text-primary">AI が読み取っただけの「未確認」として積まれます。</b>
          ここで金額と工事を確かめて確定してください。確定したものだけが工事台帳の数字になります。
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={showAll ? 'ghost' : 'secondary'}
          onClick={() => {
            setShowAll(false);
            setSelected(new Set());
          }}
        >
          未確認のみ
        </Button>
        <Button
          size="sm"
          variant={showAll ? 'secondary' : 'ghost'}
          onClick={() => {
            setShowAll(true);
            setSelected(new Set());
          }}
        >
          すべて
        </Button>
        <span className="tabular text-[11px] text-muted">
          {showAll ? `${costs.length} 件` : `未確認 ${draftCount} 件`}
        </span>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          className="ml-auto"
          onClick={() => setAdding((v) => !v)}
        >
          原価を追加
        </Button>
        {selected.size > 0 && (
          <Button
            size="sm"
            icon={<Check size={13} />}
            loading={confirmMut.isPending}
            onClick={() => confirmMut.mutate([...selected])}
          >
            選択した {selected.size} 件を確定
          </Button>
        )}
      </div>

      {adding && (
        <AddCostForm
          projects={projectsQ.data ?? []}
          vendors={vendorsQ.data ?? []}
          onDone={() => setAdding(false)}
        />
      )}

      {costsQ.isLoading ? (
        <SkeletonList count={3} />
      ) : costs.length === 0 ? (
        <EmptyState
          icon={<Inbox size={22} />}
          title={showAll ? '原価明細がまだありません' : '確認待ちはありません'}
          description="現場から LINE で領収書を送ると、AI が金額・日付・取引先を読み取ってここに積みます。"
        />
      ) : (
        <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-sunken">
                <tr>
                  <th className="px-4 py-3.5 text-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(selectableIds))
                      }
                      aria-label="未確認をすべて選択"
                    />
                  </th>
                  {['発生日', '工事', '費目', '取引先', '金額（税抜）', '消費税', '入力元', ''].map((h) => (
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
                {costs.map((c) => {
                  const draft = c.status === 'DRAFT';
                  return (
                    <tr key={c.id} className={`transition-colors hover:bg-sunken ${draft ? '' : 'opacity-70'}`}>
                      <td className="px-4 py-3.5">
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          disabled={!draft}
                          onChange={() => toggle(c.id)}
                          aria-label={`${c.description ?? '明細'} を選択`}
                        />
                      </td>
                      <td className="tabular px-4 py-3.5 text-xs text-secondary">{c.incurredOn}</td>
                      <td className="px-4 py-3.5">
                        <p className="text-xs font-bold text-primary">{c.project?.name ?? '—'}</p>
                        <p className="font-mono text-micro text-text-muted">{c.project?.code ?? ''}</p>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-secondary">
                        {COST_CATEGORY_LABEL[c.category as CostCategory] ?? c.category}
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="text-xs text-secondary">{c.vendor?.name ?? '—'}</p>
                        {c.vendor && !c.vendor.invoiceRegistered && (
                          <p className="text-micro text-warning">インボイス未登録</p>
                        )}
                      </td>
                      <td className="tabular px-4 py-3.5 text-xs font-bold text-primary">{yen(c.amount)}</td>
                      <td className="tabular px-4 py-3.5 text-xs text-secondary">{yen(c.taxAmount)}</td>
                      <td className="px-4 py-3.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-micro font-bold ${
                            draft ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'
                          }`}
                        >
                          {draft ? `未確認・${SOURCE_LABEL[c.source] ?? c.source}` : '確定'}
                        </span>
                        {c.description && (
                          <p className="mt-1 text-micro text-text-muted">{c.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-3.5">
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={<Trash2 size={11} />}
                          loading={deleteMut.isPending && deleteMut.variables === c.id}
                          onClick={() => {
                            if (confirm('この原価明細を削除しますか？')) deleteMut.mutate(c.id);
                          }}
                          aria-label="原価明細を削除"
                        />
                      </td>
                    </tr>
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

export default CostApproval;
