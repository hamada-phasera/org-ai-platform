/**
 * 出力ビルダー（docs/design/canvas-home.md §3.5）の純粋関数。ブロックの追加・並べ替え・削除と、プレビューのダミー値。
 * 検証の正本は gateway（pageDefinitionSchema → alignFlowPageDefinition → checkFlowPageDefinition）。
 */
import {
  FLOW_PAGE_ACTION_IDS,
  FLOW_PAGE_RUNS_KEY,
  flowPageColumnLabel,
  type FlowPageSource,
  type PageBlock,
  type PageBlockType,
} from '@org-ai/shared-types';

export const BLOCK_LABEL: Record<PageBlockType, string> = {
  heading: '見出し',
  text: '文章',
  kpi: '数字',
  table: '表',
  list: '一覧',
  form: 'フォーム',
  buttons: 'ボタン',
};

export const MAX_BLOCKS = 20;

/**
 * 左の部品の一覧。フォームとボタンは「実行」の形なので、きっかけに合う方だけ（フォームのきっかけ → フォーム）。
 * 数字は文字の値、表・一覧は表の値（履歴を含む）があるときだけ。
 */
export function addableBlocks(sources: readonly FlowPageSource[], triggerIsForm: boolean): PageBlockType[] {
  const hasText = sources.some((s) => s.type === 'text');
  const hasRows = sources.some((s) => s.type === 'rows' && (s.columns?.length ?? 0) > 0);
  return (['heading', 'text', 'kpi', 'table', 'list', triggerIsForm ? 'form' : 'buttons'] as PageBlockType[]).filter(
    (t) => (t !== 'kpi' || hasText) && ((t !== 'table' && t !== 'list') || hasRows),
  );
}

/** 新しいブロック（末尾に足す。1 列だけ）。データは最初の候補を選んでおく（自由入力させない） */
export function newBlock(type: PageBlockType, sources: readonly FlowPageSource[]): PageBlock {
  const query = FLOW_PAGE_ACTION_IDS.query;
  const text = sources.find((s) => s.type === 'text');
  const rows = sources.find((s) => s.type === 'rows' && (s.columns?.length ?? 0) > 0);
  switch (type) {
    case 'heading':
      return { type: 'heading', text: '見出し' };
    case 'text':
      return { type: 'text', text: '説明' };
    case 'kpi':
      return { type: 'kpi', items: [{ label: flowPageColumnLabel(text?.key ?? 'value'), source: { action: query, key: text?.key ?? '' }, format: 'text' }] };
    case 'table': {
      const cols = (rows?.columns ?? []).slice(0, 4);
      return {
        type: 'table',
        source: { action: query, key: rows?.key ?? FLOW_PAGE_RUNS_KEY },
        columns: cols.map((key) => ({ key, label: flowPageColumnLabel(key) })),
        empty: 'ありません',
      };
    }
    case 'list':
      return {
        type: 'list',
        source: { action: query, key: rows?.key ?? FLOW_PAGE_RUNS_KEY },
        titleKey: rows?.columns?.[0] ?? 'date',
        ...(rows?.columns?.[1] ? { subKey: rows.columns[1] } : {}),
        empty: 'ありません',
      };
    case 'form':
      // 項目は gateway がきっかけの項目で埋める（ここでは仮の 1 つ。保存で置き換わる）
      return { type: 'form', fields: [{ key: 'input', label: '入力', type: 'text' }], action: FLOW_PAGE_ACTION_IDS.submit, submit: '実行' };
    case 'buttons':
    default:
      return { type: 'buttons', items: [{ label: '実行', action: FLOW_PAGE_ACTION_IDS.submit, style: 'primary' }] };
  }
}

export function moveBlock<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** 実行がまだ無いときのプレビュー: 値は項目名、表は列名の 1 行 */
export function dummyRaw(sources: readonly FlowPageSource[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const s of sources) {
    if (s.type === 'text') raw[s.key] = s.key;
    else raw[s.key] = [Object.fromEntries((s.columns ?? []).map((c) => [c, flowPageColumnLabel(c)]))];
  }
  return raw;
}

/** gateway の issues（path が ['blocks', i, …]）をブロックごとに。それ以外は全体 */
export function issuesByBlock(issues: readonly { path: (string | number)[]; message: string }[]): {
  blocks: Record<number, string[]>;
  general: string[];
} {
  const blocks: Record<number, string[]> = {};
  const general: string[] = [];
  for (const i of issues) {
    if (i.path[0] === 'blocks' && typeof i.path[1] === 'number') (blocks[i.path[1]] ??= []).push(i.message);
    else general.push(i.message);
  }
  return { blocks, general };
}
