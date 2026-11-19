import { Suspense, lazy } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorState, Spinner } from '../components/ui';
import { FlowMobile } from '../components/flow/FlowMobile';
import { useFlow, useFlowParts } from '../components/flow/flowApi';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';

/* 編集画面（@xyflow/react と zod のスキーマ）は PC だけが遅延で読む。スマホはステップの縦リストだけ（K20） */
const FlowEditor = lazy(() => import('../components/flow/FlowEditor'));

/**
 * フロー画面 `/flows/:id`（docs/design/canvas-home.md §3.4・§4.3）。
 * - PC: キャンバスでノードを足し・つなぎ・設定し・保存し・実行する。履歴の 1 回をキャンバスに重ねる。
 * - スマホ: ステップの縦リスト・実行・承認待ち・履歴。ADMIN 以上は文字の設定と有効/無効だけ。
 * 見えないフロー（他組織・役割不足）は gateway が 404 を返す。
 * ⚠️ `@xyflow/react` も zod の値も静的に import しない（スマホで開く画面）。
 */
export default function FlowPage() {
  const { id = '' } = useParams();
  const flow = useFlow(id);
  const parts = useFlowParts();
  const desktop = useMediaQuery(DESKTOP_QUERY);

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
  const partList = parts.data ?? [];
  if (!desktop) return <FlowMobile flow={flow.data} parts={partList} />;
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20" aria-busy="true">
          <Spinner />
        </div>
      }
    >
      {/* 版では作り直さない（編集中に他の人の保存・取り直しが来ても未保存の編集を消さない）。合わせ方は FlowEditor の中 */}
      <FlowEditor key={flow.data.id} flow={flow.data} parts={partList} />
    </Suspense>
  );
}
