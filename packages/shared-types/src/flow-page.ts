/**
 * 業務フローの結果ページ（docs/design/canvas-home.md §3.5・§6.3）の純粋関数。
 *
 * - 結果ページは業務ページ（`CustomPage`、`source='FLOW'`）のブロック 7 種をそのまま使う。アクションは
 *   `flow_query`（直近の成功した実行の `output` ＋ 履歴 `runs`）と `flow_submit`（そのページのフローを実行）の 2 つだけで、
 *   id は固定（`FLOW_PAGE_ACTION_IDS`）。n8n の `query` / `submit` は混ぜない（K37）。
 * - ブロックが読める `source.key` は、フローの**出力ノード（kind='page'）が宣言したキー**と `rows`・予約キー `runs` だけ
 *   （自由入力させない。`flowPageSources`）。保存時に `checkFlowPageDefinition` で確かめる。
 * - フォームの項目は**きっかけの項目そのもの**（二重に定義しない）。`alignFlowPageDefinition` が保存のたびに写し直す
 *   （フローのきっかけが変われば、ページのフォームも追従する）。きっかけがフォームでなければ「実行」ボタンになる。
 *
 * ⚠️ zod を import しない（`import type` だけ）。gateway・出力ビルダー（PC の遅延チャンク）・結果ページが読む。
 */
import type { PageBlock, PageDefinition, PageField } from './pages';
import type { FlowDefinition, FlowNode, FlowNodeOf } from './flows';
import type { FlowRunStatus } from './flows-plan';
import { outputKeysOf, parseRef, type FlowOutputKey, type FlowPartSpec } from './flows-core';

/** pages.ts の PAGE_DATA_KEY_PATTERN と同じ（pages.ts は zod を読むので値は写す。テストで突き合わせる） */
export const FLOW_PAGE_DATA_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/** 結果ページのアクションの id（固定。定義にフロー ID は書かない） */
export const FLOW_PAGE_ACTION_IDS = { query: 'result', submit: 'run' } as const;

/** 履歴の予約キー（直近 50 回の実行） */
export const FLOW_PAGE_RUNS_KEY = 'runs';
/** 表の予約キー（出力ノードの `rows`） */
export const FLOW_PAGE_ROWS_KEY = 'rows';
/** 履歴の行数 */
export const FLOW_PAGE_RUNS_MAX = 50;
/** 履歴の固定の列（日時・状態）。出力ノードのスカラーの値がこの後ろに並ぶ */
export const FLOW_PAGE_RUN_COLUMNS = ['date', 'status'] as const;

export const FLOW_RUN_STATUS_LABEL: Record<FlowRunStatus, string> = {
  QUEUED: '待ち',
  RUNNING: '実行中',
  WAITING_APPROVAL: '承認待ち',
  SUCCEEDED: '完了',
  FAILED: '失敗',
  CANCELED: '取消',
  EXPIRED: '期限切れ',
};

/** ビルダーで選べるデータ（`source.key`） */
export interface FlowPageSource {
  key: string;
  /** 一語の表示名 */
  label: string;
  type: 'text' | 'rows';
  /** rows の列 */
  columns?: string[];
}

function pageOutputNode(def: FlowDefinition): FlowNodeOf<'output'> | undefined {
  return def.nodes.find((n): n is FlowNodeOf<'output'> => n.type === 'output' && n.config.kind === 'page');
}

function triggerNode(def: FlowDefinition): FlowNodeOf<'trigger'> | undefined {
  return def.nodes.find((n): n is FlowNodeOf<'trigger'> => n.type === 'trigger');
}

/** きっかけがフォームなら項目、そうでなければ null */
export function flowTriggerFields(def: FlowDefinition): PageField[] | null {
  const t = triggerNode(def);
  return t && t.config.mode === 'form' ? t.config.fields : null;
}

/** 出力ノードの値のうち、予約キーと重ならないもの（`rows` `runs` は予約） */
function scalarValueKeys(def: FlowDefinition): string[] {
  const node = pageOutputNode(def);
  if (!node || node.config.kind !== 'page') return [];
  return Object.keys(node.config.values).filter(
    (k) => k !== FLOW_PAGE_ROWS_KEY && k !== FLOW_PAGE_RUNS_KEY && FLOW_PAGE_DATA_KEY_PATTERN.test(k),
  );
}

/**
 * ビルダーで選べるデータの一覧。出力ノードの値（文字）→ 出力ノードの表（`rows`。列は参照先の宣言）→ 履歴（`runs`）。
 * 出力ノードが無いフローでも履歴は選べる。
 */
export function flowPageSources(def: FlowDefinition, parts: readonly FlowPartSpec[] = []): FlowPageSource[] {
  const sources: FlowPageSource[] = scalarValueKeys(def).map((key) => ({ key, label: key, type: 'text' }));
  const node = pageOutputNode(def);
  if (node && node.config.kind === 'page' && node.config.rows !== undefined) {
    const ref = parseRef(node.config.rows);
    const from: FlowNode | undefined = ref ? def.nodes.find((n) => n.id === ref.node) : undefined;
    const decl: FlowOutputKey | undefined = from && ref ? outputKeysOf(from, parts).find((k) => k.key === ref.key) : undefined;
    sources.push({ key: FLOW_PAGE_ROWS_KEY, label: '表', type: 'rows', columns: decl?.columns ?? [] });
  }
  sources.push({
    key: FLOW_PAGE_RUNS_KEY,
    label: '履歴',
    type: 'rows',
    columns: [...FLOW_PAGE_RUN_COLUMNS, ...scalarValueKeys(def)],
  });
  return sources;
}

const CELL_LABEL: Record<string, string> = { date: '日時', status: '状態' };

/** 列の既定の表示名（日時・状態以外は key のまま。ラベルは 8 文字まで） */
export function flowPageColumnLabel(key: string): string {
  return CELL_LABEL[key] ?? key.slice(0, 8);
}

export interface FlowPageIssue {
  path: (string | number)[];
  message: string;
}

/**
 * ブロックが読むデータと列が、そのフローの出力にあるか（保存時の検査。`pageDefinitionSchema` を通した後に使う）。
 * - アクションは `FLOW_PAGE_ACTION_IDS` の 2 つだけ（`flow_query` / `flow_submit`）
 * - kpi は文字の値だけ、表・一覧は rows の値だけ。列はその rows の列だけ
 */
export function checkFlowPageDefinition(
  page: PageDefinition,
  def: FlowDefinition,
  parts: readonly FlowPartSpec[] = [],
): FlowPageIssue[] {
  const issues: FlowPageIssue[] = [];
  const ids = Object.keys(page.actions);
  const expected = [FLOW_PAGE_ACTION_IDS.query, FLOW_PAGE_ACTION_IDS.submit];
  if (
    ids.length !== expected.length ||
    page.actions[FLOW_PAGE_ACTION_IDS.query]?.kind !== 'flow_query' ||
    page.actions[FLOW_PAGE_ACTION_IDS.submit]?.kind !== 'flow_submit'
  ) {
    issues.push({ path: ['actions'], message: 'アクションは結果の取得と実行の 2 つだけです' });
  }
  const sources = new Map(flowPageSources(def, parts).map((s) => [s.key, s]));
  const need = (key: string, type: FlowPageSource['type'], path: (string | number)[]): FlowPageSource | null => {
    const s = sources.get(key);
    if (!s) {
      issues.push({ path, message: `データ「${key}」はこのフローの出力にありません` });
      return null;
    }
    if (s.type !== type) {
      issues.push({ path, message: type === 'rows' ? `「${key}」は表ではありません` : `「${key}」は表なので数字には使えません` });
      return null;
    }
    return s;
  };
  page.blocks.forEach((block, i) => {
    switch (block.type) {
      case 'kpi':
        block.items.forEach((item, j) => need(item.source.key, 'text', ['blocks', i, 'items', j, 'source', 'key']));
        break;
      case 'table': {
        const s = need(block.source.key, 'rows', ['blocks', i, 'source', 'key']);
        if (s) {
          block.columns.forEach((c, j) => {
            if (!s.columns?.includes(c.key)) issues.push({ path: ['blocks', i, 'columns', j, 'key'], message: `列「${c.key}」はありません` });
          });
        }
        if (block.rowAction) issues.push({ path: ['blocks', i, 'rowAction'], message: '行の操作は使えません' });
        break;
      }
      case 'list': {
        const s = need(block.source.key, 'rows', ['blocks', i, 'source', 'key']);
        if (s) {
          for (const k of [block.titleKey, block.subKey, block.metaKey]) {
            if (k !== undefined && !s.columns?.includes(k)) issues.push({ path: ['blocks', i], message: `列「${k}」はありません` });
          }
        }
        break;
      }
      default:
        break;
    }
  });
  return issues;
}

/**
 * フォーム・ボタンをフローのきっかけに合わせる（保存のたびに通す。冪等）。
 * - きっかけがフォーム: 実行のボタンはフォームに替え、フォームの項目はきっかけの項目そのものにする
 * - きっかけがフォーム以外: 実行のフォームはボタン（1 つ）に替える
 * アクションは `FLOW_PAGE_ACTION_IDS` の 2 つに揃える。
 */
export function alignFlowPageDefinition(page: PageDefinition, def: FlowDefinition): PageDefinition {
  const fields = flowTriggerFields(def);
  const submit = FLOW_PAGE_ACTION_IDS.submit;
  const blocks: PageBlock[] = page.blocks.map((block): PageBlock => {
    if (block.type === 'form' && block.action === submit) {
      if (fields) return { ...block, fields: fields.map((f) => ({ ...f })) };
      return { type: 'buttons', items: [{ label: block.submit, action: submit, style: 'primary' }] };
    }
    if (block.type === 'buttons' && fields && block.items.some((it) => it.action === submit)) {
      const label = block.items.find((it) => it.action === submit)?.label ?? '実行';
      return { type: 'form', fields: fields.map((f) => ({ ...f })), action: submit, submit: label };
    }
    return block;
  });
  return {
    blocks,
    actions: { [FLOW_PAGE_ACTION_IDS.query]: { kind: 'flow_query' }, [submit]: { kind: 'flow_submit' } },
  };
}

/**
 * 出力ビルダーの最初の案（結果ページの行がまだ無いとき）。見出し → 実行（フォームかボタン）→ 値の数字 → 表 → 履歴。
 * LLM も乱数も使わない（同じフローなら毎回同じ）。
 */
export function defaultFlowPageDefinition(
  def: FlowDefinition,
  title: string,
  parts: readonly FlowPartSpec[] = [],
): PageDefinition {
  const blocks: PageBlock[] = [{ type: 'heading', text: title.slice(0, 40) || '結果' }];
  const fields = flowTriggerFields(def);
  blocks.push(
    fields
      ? { type: 'form', fields: fields.map((f) => ({ ...f })), action: FLOW_PAGE_ACTION_IDS.submit, submit: '実行' }
      : { type: 'buttons', items: [{ label: '実行', action: FLOW_PAGE_ACTION_IDS.submit, style: 'primary' }] },
  );
  const sources = flowPageSources(def, parts);
  const scalars = sources.filter((s) => s.type === 'text').slice(0, 4);
  if (scalars.length > 0) {
    blocks.push({
      type: 'kpi',
      items: scalars.map((s) => ({
        label: flowPageColumnLabel(s.key),
        source: { action: FLOW_PAGE_ACTION_IDS.query, key: s.key },
        format: 'text' as const,
      })),
    });
  }
  for (const s of sources.filter((x) => x.type === 'rows')) {
    const columns = (s.columns ?? []).slice(0, 8);
    if (columns.length === 0) continue;
    blocks.push({
      type: 'table',
      source: { action: FLOW_PAGE_ACTION_IDS.query, key: s.key },
      columns: columns.map((key) => ({
        key,
        label: flowPageColumnLabel(key),
        ...(key === 'date' && s.key === FLOW_PAGE_RUNS_KEY ? { format: 'date' as const } : {}),
        ...(key === 'status' && s.key === FLOW_PAGE_RUNS_KEY ? { format: 'badge' as const } : {}),
      })),
      empty: s.key === FLOW_PAGE_RUNS_KEY ? 'まだ実行がありません' : 'ありません',
    });
  }
  return alignFlowPageDefinition({ blocks, actions: {} }, def);
}

/** 日本時間の `YYYY-MM-DD HH:mm`（履歴の日時の列） */
export function jstDateTime(d: Date): string {
  const j = new Date(d.getTime() + 9 * 3600_000).toISOString();
  return `${j.slice(0, 10)} ${j.slice(11, 16)}`;
}

/**
 * `flow_query` の生の値（projectQueryResult に渡す前）。
 * 直近の成功した実行の `output`（値と rows）＋ 履歴 `runs`（新しい順。日時・状態・値のスカラー）。
 */
export function flowQueryRaw(
  def: FlowDefinition,
  latestOutput: Record<string, unknown> | null,
  runs: { createdAt: Date | string; status: string; output: unknown }[],
): Record<string, unknown> {
  const keys = scalarValueKeys(def);
  const raw: Record<string, unknown> = {};
  const out = latestOutput && typeof latestOutput === 'object' && !Array.isArray(latestOutput) ? latestOutput : {};
  for (const k of keys) raw[k] = Object.prototype.hasOwnProperty.call(out, k) ? scalarOf(out[k]) : null;
  const pageNode = pageOutputNode(def);
  if (pageNode && pageNode.config.kind === 'page' && pageNode.config.rows !== undefined) {
    const rows = Object.prototype.hasOwnProperty.call(out, FLOW_PAGE_ROWS_KEY) ? out[FLOW_PAGE_ROWS_KEY] : undefined;
    raw[FLOW_PAGE_ROWS_KEY] = Array.isArray(rows) ? rows : [];
  }
  raw[FLOW_PAGE_RUNS_KEY] = runs.slice(0, FLOW_PAGE_RUNS_MAX).map((r) => {
    const o = r.output && typeof r.output === 'object' && !Array.isArray(r.output) ? (r.output as Record<string, unknown>) : {};
    const row: Record<string, unknown> = {
      date: jstDateTime(new Date(r.createdAt)),
      status: (FLOW_RUN_STATUS_LABEL as Record<string, string>)[r.status] ?? r.status,
    };
    for (const k of keys) row[k] = Object.prototype.hasOwnProperty.call(o, k) ? scalarOf(o[k]) : null;
    return row;
  });
  return raw;
}

function scalarOf(v: unknown): string | number | boolean | null {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return null;
}
