import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { FLOW_NODE_TYPE_LABEL, topoOrder, type FlowDefinition, type FlowNodeType } from '@org-ai/shared-types';
import { api } from '../services/api';
import { ErrorState, Spinner } from '../components/ui';
import { PageIconGlyph } from '../components/canvas/PageIconGlyph';

interface FlowDetail {
  id: string;
  name: string;
  icon: string;
  /** 古い形の行もありうる（gateway は valid: false で返す）。描くのは id・type・label だけ */
  definition: FlowDefinition;
}

/**
 * フロー画面 `/flows/:id`（docs/design/canvas-home.md §3.4・§4.3）。
 * チャンク 7 はホームから開く先として、手順の縦リスト（読み取り）だけを出す。
 * 編集・実行・履歴・出力はチャンク 8 でこの画面に足す。
 * ⚠️ `@xyflow/react` も zod の値も import しない（スマホで開く画面）。
 */
export default function FlowPage() {
  const { id = '' } = useParams();
  const flow = useQuery<FlowDetail>({
    queryKey: ['flow', id],
    queryFn: async () => (await api.get(`/flows/${encodeURIComponent(id)}`)).data.data as FlowDetail,
    enabled: !!id,
    retry: false,
  });

  if (flow.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  if (flow.isError || !flow.data) {
    return (
      <div className="mx-auto max-w-[760px] px-5 py-10">
        <ErrorState title="フローを開けませんでした" description="消えたか、見る権限がありません。" />
      </div>
    );
  }

  const raw = flow.data.definition as Partial<FlowDefinition> | null;
  const def = {
    nodes: Array.isArray(raw?.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw?.edges) ? raw.edges : [],
  } as FlowDefinition;
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const order = topoOrder(def) ?? def.nodes.map((n) => n.id);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-5 pb-16 pt-6 lg:pt-8">
        <Link to="/" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-secondary hover:text-primary lg:min-h-0">
          <ArrowLeft size={15} aria-hidden="true" />
          ホーム
        </Link>
        <h1 className="mt-2 flex items-center gap-2.5 text-h2 font-extrabold">
          <PageIconGlyph name={flow.data.icon} size={20} strokeWidth={2} className="shrink-0 text-secondary" aria-hidden="true" />
          {flow.data.name}
        </h1>

        <ol className="mt-5 divide-y divide-hairline border-y border-border" aria-label="手順">
          {order.map((nodeId, i) => {
            const node = byId.get(nodeId);
            if (!node) return null;
            const type = FLOW_NODE_TYPE_LABEL[node.type as FlowNodeType] ?? '';
            return (
              <li key={node.id} className="flex min-h-14 items-center gap-3 px-1 py-2.5">
                <span className="w-6 shrink-0 text-right font-mono text-sm text-text-muted tabular">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-body font-bold text-primary">{node.label}</span>
                <span className="shrink-0 text-xs font-bold text-text-muted">{type}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
