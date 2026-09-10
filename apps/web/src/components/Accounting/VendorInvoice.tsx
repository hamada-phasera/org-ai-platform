import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Users } from 'lucide-react';
import { api } from '../../services/api';
import { Button, Card, EmptyState, Input, SkeletonList } from '../ui';
import {
  VENDOR_KINDS,
  VENDOR_KIND_LABEL,
  yen,
  type InvoiceImpact,
  type VendorKind,
  type VendorRow,
} from './types';

/**
 * 取引先とインボイス登録状況。
 *
 * ここが会計ソフトの守備範囲の外側にあたる。freee / マネーフォワードは仕訳を持つが、
 * 「どの外注先が適格請求書発行事業者として登録していて、未登録の相手にいくら払っていて、
 * 経過措置が下がると負担がいくら増えるか」という台帳は持っていない。
 * 元請はこれを把握していないまま期日を迎えることが多い。
 *
 * ⚠️ 出すのは概算まで。税務判断はしない。
 */

interface ImpactResponse {
  impact: InvoiceImpact;
  unregisteredVendors: Array<{ id: string; name: string; kind: string; amount: number; taxAmount: number }>;
  unlinkedCostEntryCount?: number;
}

/** 「あと N 日」の緊急度。1ヶ月を切ったら赤。 */
function urgencyClass(daysLeft: number): string {
  if (daysLeft <= 30) return 'text-danger';
  if (daysLeft <= 90) return 'text-warning';
  return 'text-primary';
}

function ImpactBanner({ data }: { data: ImpactResponse }) {
  const { impact, unregisteredVendors, unlinkedCostEntryCount } = data;
  const nextQ = useQuery({
    queryKey: ['accounting-summary'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: { invoice: { next: { from: string; rate: number; daysLeft: number } | null } } }>(
        '/accounting/summary',
      );
      return res.data.data;
    },
  });
  const next = nextQ.data?.invoice.next ?? null;

  return (
    <Card variant="regular" padding="md" radius="2xl" className="space-y-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-primary">インボイス経過措置の影響</h3>
          <p className="mt-1 text-xs leading-relaxed text-secondary">
            適格請求書発行事業者でない相手に払った消費税は、一定割合しか控除できません。
            この割合は段階的に下がります。
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl bg-sunken p-3.5">
          <p className="text-micro font-semibold uppercase tracking-[0.15em] text-muted">
            現在の控除割合
          </p>
          <p className="tabular mt-1 text-lg font-bold text-primary">
            {Math.round(impact.currentRate * 100)}%
          </p>
          {next && (
            <p className="text-micro text-text-muted">
              {next.from} に {Math.round(next.rate * 100)}% へ
            </p>
          )}
        </div>

        <div className="rounded-2xl bg-sunken p-3.5">
          <p className="text-micro font-semibold uppercase tracking-[0.15em] text-muted">
            次の切り替えまで
          </p>
          {next ? (
            <>
              <p className={`tabular mt-1 text-lg font-bold ${urgencyClass(next.daysLeft)}`}>
                あと {next.daysLeft} 日
              </p>
              <p className="text-micro text-text-muted">{next.from}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-secondary">経過措置は終了しています</p>
          )}
        </div>

        <div className="rounded-2xl bg-sunken p-3.5">
          <p className="text-micro font-semibold uppercase tracking-[0.15em] text-muted">
            切り替えで増える負担
          </p>
          <p
            className={`tabular mt-1 text-lg font-bold ${
              impact.additionalBurden > 0 ? 'text-danger' : 'text-primary'
            }`}
          >
            {yen(impact.additionalBurden)}
          </p>
          <p className="text-micro text-text-muted">
            未登録先 {unregisteredVendors.length} 社・消費税 {yen(impact.unregisteredTax)} 分
          </p>
        </div>
      </div>

      {unlinkedCostEntryCount !== undefined && unlinkedCostEntryCount > 0 && (
        <p className="text-micro text-warning">
          取引先が紐付いていない原価明細が {unlinkedCostEntryCount} 件あります。
          紐付けるとこの試算に反映されます。
        </p>
      )}

      <p className="text-micro leading-relaxed text-text-muted">
        これは登録状況と取引額からの概算です。実際の申告や個別の取り扱いは顧問税理士にご確認ください。
      </p>
    </Card>
  );
}

function AddVendorForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    kind: 'SUBCON' as VendorKind,
    invoiceNumber: '',
    invoiceRegistered: false,
  });
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post('/accounting/vendors', {
        name: form.name.trim(),
        kind: form.kind,
        invoiceRegistered: form.invoiceRegistered,
        invoiceNumber: form.invoiceNumber.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting-vendors'] });
      qc.invalidateQueries({ queryKey: ['accounting-invoice-impact'] });
      onDone();
    },
    onError: (err) => {
      const data = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data;
      setError(data?.error?.message ?? '登録できませんでした');
    },
  });

  return (
    <Card variant="regular" padding="md" radius="2xl" className="space-y-3">
      <div className="grid gap-2.5 sm:grid-cols-3">
        <Input
          size="sm"
          placeholder="取引先名"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <select
          className="rounded-sm border border-border bg-elevated px-3 py-2 text-xs text-primary"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as VendorKind })}
          aria-label="取引先の種別"
        >
          {VENDOR_KINDS.map((k) => (
            <option key={k} value={k}>
              {VENDOR_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <Input
          size="sm"
          placeholder="登録番号 T1234567890123"
          value={form.invoiceNumber}
          onChange={(e) =>
            setForm({
              ...form,
              invoiceNumber: e.target.value,
              // 番号を入れたら登録済みとみなす（二重入力させない）
              invoiceRegistered: e.target.value.trim().length > 0 ? true : form.invoiceRegistered,
            })
          }
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-secondary">
        <input
          type="checkbox"
          checked={form.invoiceRegistered}
          onChange={(e) => setForm({ ...form, invoiceRegistered: e.target.checked })}
        />
        適格請求書発行事業者として登録している
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          loading={mut.isPending}
          disabled={!form.name.trim()}
          onClick={() => {
            setError(null);
            mut.mutate();
          }}
        >
          取引先を登録
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          やめる
        </Button>
        <p className="ml-auto text-micro text-text-muted">
          一人親方は「外注費か給与か」が見られやすいので、種別を分けておくと後で楽です。
        </p>
      </div>
    </Card>
  );
}

export function VendorInvoice() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const vendorsQ = useQuery({
    queryKey: ['accounting-vendors'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: VendorRow[] }>('/accounting/vendors');
      return res.data.data;
    },
  });

  const impactQ = useQuery({
    queryKey: ['accounting-invoice-impact'],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: ImpactResponse }>(
        '/accounting/vendors/invoice-impact',
      );
      return res.data.data;
    },
  });

  const [toggleError, setToggleError] = useState<string | null>(null);

  const toggleMut = useMutation({
    mutationFn: ({ id, registered }: { id: string; registered: boolean }) =>
      api.patch(`/accounting/vendors/${id}`, { invoiceRegistered: registered }),
    onSuccess: () => {
      setToggleError(null);
      qc.invalidateQueries({ queryKey: ['accounting-vendors'] });
      qc.invalidateQueries({ queryKey: ['accounting-invoice-impact'] });
    },
    onError: (err) => {
      const data = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data;
      // 黙って元に戻ると「登録済みにしたはず」の取引先が未登録のまま試算に乗り続ける
      setToggleError(data?.error?.message ?? '登録状況を変更できませんでした');
    },
  });

  const vendors = vendorsQ.data ?? [];

  return (
    <div className="space-y-5">
      {impactQ.data && <ImpactBanner data={impactQ.data} />}

      <div className="flex flex-wrap items-center gap-2">
        <Users size={16} className="text-accent" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-primary">取引先</h2>
        <span className="tabular text-[11px] text-muted">{vendors.length} 社</span>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={13} />}
          className="ml-auto"
          onClick={() => setAdding((v) => !v)}
        >
          取引先を追加
        </Button>
      </div>

      {toggleError && <p className="text-xs text-danger">{toggleError}</p>}

      {adding && <AddVendorForm onDone={() => setAdding(false)} />}

      {vendorsQ.isLoading ? (
        <SkeletonList count={3} />
      ) : vendors.length === 0 ? (
        <EmptyState
          icon={<Users size={22} />}
          title="取引先がまだありません"
          description="外注先や資材業者を登録して、インボイスの登録状況を持っておくと、経過措置が下がるときの負担が先に分かります。"
          action={{ label: '取引先を追加', onClick: () => setAdding(true) }}
        />
      ) : (
        <Card variant="regular" padding="none" radius="2xl" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-sunken">
                <tr>
                  {['取引先', '種別', 'インボイス', '登録番号', '取引額（税抜）', '消費税', ''].map((h) => (
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
                {vendors.map((v) => (
                  <tr key={v.id} className="transition-colors hover:bg-sunken">
                    <td className="px-4 py-3.5 text-xs font-bold text-primary">{v.name}</td>
                    <td className="px-4 py-3.5 text-xs text-secondary">
                      {VENDOR_KIND_LABEL[v.kind as VendorKind] ?? v.kind}
                    </td>
                    <td className="px-4 py-3.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-micro font-bold ${
                          v.invoiceRegistered ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
                        }`}
                      >
                        {v.invoiceRegistered ? '登録済み' : '未登録'}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 font-mono text-micro text-text-muted">
                      {v.invoiceNumber ?? '—'}
                    </td>
                    <td className="tabular px-4 py-3.5 text-xs text-secondary">{yen(v.stats.amount)}</td>
                    <td className="tabular px-4 py-3.5 text-xs text-secondary">
                      {yen(v.stats.taxAmount)}
                      {!v.invoiceRegistered && v.stats.taxAmount > 0 && (
                        <p className="text-micro text-warning">控除が減る対象</p>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={toggleMut.isPending && toggleMut.variables?.id === v.id}
                        onClick={() =>
                          toggleMut.mutate({ id: v.id, registered: !v.invoiceRegistered })
                        }
                      >
                        {v.invoiceRegistered ? '未登録にする' : '登録済みにする'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

export default VendorInvoice;
