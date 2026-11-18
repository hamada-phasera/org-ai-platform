/**
 * 業務ページ（docs/design/custom-pages.md §4）のスキーマと純粋関数。
 *
 * - ページ定義は n8n から届く＝信用しない。すべて `.strict()`（知らないキーは拒否）、ブロックは許可リストの 7 種だけ。
 * - 定義に書けるのは Webhook の**末尾の名前（hook）だけ**。URL は gateway が `pages/<JWT の orgId>/<hook>` に組み立てる
 *   ので、他組織や既存（dept-* / cap-* / agent-*）のワークフローには構造的に届かない（設計書 K2・T2）。
 * - n8n の応答は `projectQueryResult` で宣言した key とスカラーだけに切り詰めてから web に渡す（K12）。
 * - web は同じスキーマでフォームの入力を検証する（`buildInputSchema`）。web では `/p/*` の遅延チャンクからだけ読むこと
 *   （zod を初回ロードに載せない。K20）。zod に依存しない定数と上限は pages-plan.ts。
 */
import { z } from 'zod';
import { PAGE_ICONS, PAGE_STATUSES, hasControlChars, utf8ByteLength } from './pages-plan';

// ── 上限（設計書 §4.2・§4.3・§5.2） ─────────────────────────────

export const PAGE_SCHEMA_VERSION = 1;

export const PAGE_DEFINITION_LIMITS = {
  /** 定義全体の JSON（UTF-8）のバイト数 */
  maxDefinitionBytes: 32 * 1024,
  maxBlocks: 20,
  maxActions: 12,
  titleMax: 24,
  headingMax: 40,
  textMax: 500,
  kpiItemsMax: 4,
  /** ラベルは一語（DESIGN.md）。表の列・KPI・フォームの項目 */
  labelMax: 8,
  /** ボタンの文字（ボタン・送信・行の操作） */
  buttonLabelMax: 6,
  confirmMax: 60,
  emptyMax: 40,
  formTitleMax: 24,
  tableColumnsMax: 8,
  tableRowsMax: 200,
  listRowsMax: 100,
  cellMax: 200,
  kpiTextMax: 32,
  rowIdMax: 128,
  fieldsMax: 12,
  buttonsMax: 3,
  optionsMax: 30,
  optionValueMax: 64,
  optionLabelMax: 24,
  /** text / email / tel の maxLength の既定と上限 */
  textInputDefault: 200,
  textInputMax: 500,
  /** textarea の maxLength の上限（既定は textInputDefault） */
  textareaMax: 2000,
  /** n8n からの submit 応答の message */
  submitMessageMax: 140,
} as const;

const L = PAGE_DEFINITION_LIMITS;

// ── 部品 ─────────────────────────────────────────────

/** slug と hook の形（英小文字・数字・ハイフン、先頭末尾は英数字、1〜40 文字）。`/` `.` `%` `:` は書けない */
export const PAGE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const PAGE_ACTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
export const PAGE_DATA_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

const CONTROL_MSG = '制御文字は使えません';

/** 表示する文字（1 文字以上・上限・制御文字なし） */
const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChars(v), CONTROL_MSG);

const multiline = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChars(v, true), CONTROL_MSG);

export const pageSlugSchema = z.string().regex(PAGE_SLUG_PATTERN, 'slug は英小文字・数字・ハイフン（1〜40 文字）');
export const pageHookSchema = z.string().regex(PAGE_SLUG_PATTERN, 'hook は英小文字・数字・ハイフン（1〜40 文字）');
export const pageActionIdSchema = z
  .string()
  .regex(PAGE_ACTION_ID_PATTERN, 'アクション ID は英小文字で始まる英小文字・数字・_（1〜24 文字）');
export const pageDataKeySchema = z
  .string()
  .regex(PAGE_DATA_KEY_PATTERN, 'key は英字で始まる英数字・_（1〜32 文字）');

const sourceSchema = z.object({ action: pageActionIdSchema, key: pageDataKeySchema }).strict();

// ── アクション ─────────────────────────────────────────

const queryActionSchema = z.object({ kind: z.literal('query'), hook: pageHookSchema }).strict();
const submitActionSchema = z
  .object({
    kind: z.literal('submit'),
    hook: pageHookSchema,
    confirm: label(L.confirmMax).optional(),
    /** 送信後に取り直す query。省略＝全部 */
    refresh: z.array(pageActionIdSchema).max(L.maxActions).optional(),
  })
  .strict();
/**
 * 業務フローの結果ページ（`CustomPage.source='FLOW'`）だけで使うアクション（docs/design/canvas-home.md §6.3）。
 * - `flow_query`: 直近の成功した実行の `output` ＋ 履歴（`runs`）を読む
 * - `flow_submit`: そのページの `flowId` のフローを実行する
 * **フロー ID は定義に書かない**（`CustomPage.flowId` の 1 つだけ＝他のフローを叩けない）。hook も無い（n8n に届かない）。
 * n8n の登録経路（`pageUpsertSchema`）は拒否する。
 */
const flowQueryActionSchema = z.object({ kind: z.literal('flow_query') }).strict();
const flowSubmitActionSchema = z.object({ kind: z.literal('flow_submit') }).strict();
export const pageActionSchema = z.discriminatedUnion('kind', [
  queryActionSchema,
  submitActionSchema,
  flowQueryActionSchema,
  flowSubmitActionSchema,
]);

export const PAGE_FLOW_ACTION_KINDS = ['flow_query', 'flow_submit'] as const;
export type PageActionKind = 'query' | 'submit' | 'flow_query' | 'flow_submit';

/** 読む側（query と flow_query）か */
export function isPageQueryKind(kind: PageActionKind): boolean {
  return kind === 'query' || kind === 'flow_query';
}

/** 送る側（submit と flow_submit）か */
export function isPageSubmitKind(kind: PageActionKind): boolean {
  return kind === 'submit' || kind === 'flow_submit';
}

export function isPageFlowActionKind(kind: PageActionKind): boolean {
  return kind === 'flow_query' || kind === 'flow_submit';
}

// ── ブロック（許可リスト 7 種） ─────────────────────────────

const headingBlockSchema = z.object({ type: z.literal('heading'), text: label(L.headingMax) }).strict();

/** プレーンのみ。改行は残す。Markdown・リンク化はしない */
const textBlockSchema = z.object({ type: z.literal('text'), text: multiline(L.textMax) }).strict();

const kpiBlockSchema = z
  .object({
    type: z.literal('kpi'),
    items: z
      .array(
        z
          .object({
            label: label(L.labelMax),
            source: sourceSchema,
            format: z.enum(['number', 'yen', 'percent', 'text']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(L.kpiItemsMax),
  })
  .strict();

const rowActionSchema = z.object({ label: label(L.buttonLabelMax), action: pageActionIdSchema }).strict();

const tableBlockSchema = z
  .object({
    type: z.literal('table'),
    source: sourceSchema,
    columns: z
      .array(
        z
          .object({
            key: pageDataKeySchema,
            label: label(L.labelMax),
            format: z.enum(['text', 'number', 'yen', 'date', 'badge']).optional(),
            primary: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(L.tableColumnsMax),
    rowKey: pageDataKeySchema.optional(),
    rowAction: rowActionSchema.optional(),
    empty: label(L.emptyMax).optional(),
  })
  .strict();

const listBlockSchema = z
  .object({
    type: z.literal('list'),
    source: sourceSchema,
    titleKey: pageDataKeySchema,
    subKey: pageDataKeySchema.optional(),
    metaKey: pageDataKeySchema.optional(),
    empty: label(L.emptyMax).optional(),
  })
  .strict();

export const PAGE_FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'email', 'tel'] as const;
export type PageFieldType = (typeof PAGE_FIELD_TYPES)[number];

export const pageFieldSchema = z
  .object({
    key: pageDataKeySchema,
    label: label(L.labelMax),
    /** これ以外は拒否（file / password / hidden / url / html は無い） */
    type: z.enum(PAGE_FIELD_TYPES),
    required: z.boolean().optional(),
    maxLength: z.number().int().min(1).max(L.textareaMax).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z
      .array(z.object({ value: label(L.optionValueMax), label: label(L.optionLabelMax) }).strict())
      .min(1)
      .max(L.optionsMax)
      .optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const textLike = f.type === 'text' || f.type === 'email' || f.type === 'tel';
    if (f.maxLength !== undefined) {
      if (!textLike && f.type !== 'textarea') {
        ctx.addIssue({ code: 'custom', path: ['maxLength'], message: 'maxLength は文字の項目だけに書けます' });
      } else if (textLike && f.maxLength > L.textInputMax) {
        ctx.addIssue({ code: 'custom', path: ['maxLength'], message: `maxLength は ${L.textInputMax} までです` });
      }
    }
    if ((f.min !== undefined || f.max !== undefined) && f.type !== 'number') {
      ctx.addIssue({ code: 'custom', path: ['min'], message: 'min / max は number の項目だけに書けます' });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: 'min が max より大きい' });
    }
    if (f.type === 'select') {
      if (!f.options) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'select には options が要ります' });
      } else if (new Set(f.options.map((o) => o.value)).size !== f.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'options の value が重複しています' });
      }
    } else if (f.options) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'options は select の項目だけに書けます' });
    }
  });

const formBlockSchema = z
  .object({
    type: z.literal('form'),
    title: label(L.formTitleMax).optional(),
    fields: z.array(pageFieldSchema).min(1).max(L.fieldsMax),
    action: pageActionIdSchema,
    submit: label(L.buttonLabelMax),
  })
  .strict();

const buttonsBlockSchema = z
  .object({
    type: z.literal('buttons'),
    items: z
      .array(
        z
          .object({
            label: label(L.buttonLabelMax),
            action: pageActionIdSchema,
            style: z.enum(['primary', 'secondary']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(L.buttonsMax),
  })
  .strict();

export const pageBlockSchema = z.discriminatedUnion('type', [
  headingBlockSchema,
  textBlockSchema,
  kpiBlockSchema,
  tableBlockSchema,
  listBlockSchema,
  formBlockSchema,
  buttonsBlockSchema,
]);

export const PAGE_BLOCK_TYPES = ['heading', 'text', 'kpi', 'table', 'list', 'form', 'buttons'] as const;
export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];

// ── ページ定義 ─────────────────────────────────────────

const baseDefinitionSchema = z
  .object({
    blocks: z.array(pageBlockSchema).min(1).max(L.maxBlocks),
    actions: z.record(pageActionIdSchema, pageActionSchema),
  })
  .strict();

/**
 * ページ定義のスキーマを組み立てる。
 * - `allowFlowActions: false`（n8n・手動の登録経路）: `flow_query` / `flow_submit` を拒否（登録トークンでページをフローに結べない）
 * - `allowFlowActions: true`（保存済みの定義を読む側・出力ビルダー）: 使えるが、n8n の `query` / `submit` と**混ぜない**
 *   （フローの結果ページは n8n を呼ばない）。`flow_query` と `flow_submit` は各 1 つまで。表の行の操作には使えない
 *   （行の操作は `{ rowId }` を送るだけで、フローのきっかけの項目と合わない）。
 */
export function buildPageDefinitionSchema(opts: { allowFlowActions: boolean }) {
  return baseDefinitionSchema.superRefine((def, ctx) => checkPageDefinition(def, ctx, opts.allowFlowActions));
}

function checkPageDefinition(def: z.infer<typeof baseDefinitionSchema>, ctx: z.RefinementCtx, allowFlowActions: boolean): void {
  const kinds = Object.values(def.actions).map((a) => a.kind);
  const flowKinds = kinds.filter((k) => isPageFlowActionKind(k));
  if (flowKinds.length > 0) {
    if (!allowFlowActions) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'flow_query / flow_submit は業務フローの結果ページだけで使えます' });
    } else if (flowKinds.length !== kinds.length) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'フローのアクションと n8n のアクションは混ぜられません' });
    }
    for (const k of PAGE_FLOW_ACTION_KINDS) {
      if (kinds.filter((x) => x === k).length > 1) {
        ctx.addIssue({ code: 'custom', path: ['actions'], message: `${k} は 1 つまでです` });
      }
    }
  }

  const actionIds = Object.keys(def.actions);
  if (actionIds.length > L.maxActions) {
    ctx.addIssue({ code: 'custom', path: ['actions'], message: `アクションは ${L.maxActions} 個までです` });
  }
  if (utf8ByteLength(JSON.stringify(def)) > L.maxDefinitionBytes) {
    ctx.addIssue({ code: 'custom', path: [], message: `定義は ${L.maxDefinitionBytes / 1024}KB までです` });
  }

  /** query は flow_query も、submit は flow_submit も受ける。`exact` なら n8n のアクションだけ */
  const expectKind = (actionId: string, kind: 'query' | 'submit', path: (string | number)[], exact = false) => {
    const action = Object.prototype.hasOwnProperty.call(def.actions, actionId) ? def.actions[actionId] : undefined;
    const ok = action && (exact ? action.kind === kind : kind === 'query' ? isPageQueryKind(action.kind) : isPageSubmitKind(action.kind));
    if (!action) {
      ctx.addIssue({ code: 'custom', path, message: `アクション "${actionId}" がありません` });
    } else if (!ok) {
      ctx.addIssue({ code: 'custom', path, message: `アクション "${actionId}" は ${kind} ではありません` });
    }
  };

  let primaryButtons = 0;
  def.blocks.forEach((block, i) => {
    const at = ['blocks', i];
    switch (block.type) {
      case 'kpi':
        block.items.forEach((item, j) => expectKind(item.source.action, 'query', [...at, 'items', j, 'source', 'action']));
        break;
      case 'table': {
        expectKind(block.source.action, 'query', [...at, 'source', 'action']);
        if (block.rowAction) {
          expectKind(block.rowAction.action, 'submit', [...at, 'rowAction', 'action'], true);
          if (!block.rowKey) ctx.addIssue({ code: 'custom', path: [...at, 'rowKey'], message: 'rowAction には rowKey が要ります' });
        }
        const keys = block.columns.map((c) => c.key);
        if (new Set(keys).size !== keys.length) {
          ctx.addIssue({ code: 'custom', path: [...at, 'columns'], message: '列の key が重複しています' });
        }
        if (block.columns.filter((c) => c.primary).length > 1) {
          ctx.addIssue({ code: 'custom', path: [...at, 'columns'], message: 'primary の列は 1 つまでです' });
        }
        break;
      }
      case 'list':
        expectKind(block.source.action, 'query', [...at, 'source', 'action']);
        break;
      case 'form': {
        expectKind(block.action, 'submit', [...at, 'action']);
        const keys = block.fields.map((f) => f.key);
        if (new Set(keys).size !== keys.length) {
          ctx.addIssue({ code: 'custom', path: [...at, 'fields'], message: '項目の key が重複しています' });
        }
        break;
      }
      case 'buttons':
        block.items.forEach((item, j) => {
          expectKind(item.action, 'submit', [...at, 'items', j, 'action']);
          if (item.style === 'primary') primaryButtons++;
        });
        break;
      default:
        break;
    }
  });
  if (primaryButtons > 1) {
    ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'primary のボタンは 1 ページに 1 つまでです' });
  }

  for (const [id, action] of Object.entries(def.actions)) {
    if (action.kind === 'submit' && action.refresh) {
      action.refresh.forEach((ref, j) => expectKind(ref, 'query', ['actions', id, 'refresh', j]));
    }
  }
}

/** 保存済みの定義を読む側（業務ページの取得・実行・フローの結果ページ）。flow_* を含みうる */
export const pageDefinitionSchema = buildPageDefinitionSchema({ allowFlowActions: true });

/** n8n・手動の登録経路の定義。flow_* を拒否する */
export const pageRegisterDefinitionSchema = buildPageDefinitionSchema({ allowFlowActions: false });

export type PageDefinition = z.infer<typeof baseDefinitionSchema>;
export type PageBlock = z.infer<typeof pageBlockSchema>;
export type PageAction = z.infer<typeof pageActionSchema>;
export type PageField = z.infer<typeof pageFieldSchema>;
export type PageSourceRef = z.infer<typeof sourceSchema>;

/**
 * n8n（と管理者の手動 upsert）からの登録の body（設計書 §5.3）。
 * `sampleData` `source` `orgId` は受け付けない（`.strict()`）。`sampleData` を書けるのは seed だけ（T16）。
 */
export const pageUpsertSchema = z
  .object({
    title: label(L.titleMax),
    icon: z.enum(PAGE_ICONS).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    status: z.enum(PAGE_STATUSES).optional(),
    minRole: z.enum(['MEMBER', 'ADMIN', 'OWNER']).optional(),
    /** flow_query / flow_submit は拒否（登録トークンでページをフローに結べない。canvas-home.md §6.3） */
    definition: pageRegisterDefinitionSchema,
  })
  .strict();
export type PageUpsertInput = z.infer<typeof pageUpsertSchema>;

// ── 利用者に返す定義（hook を落とす。T17） ────────────────────────

export type PublicPageAction =
  | { kind: 'query' }
  | { kind: 'submit'; confirm?: string; refresh?: string[] }
  | { kind: 'flow_query' }
  | { kind: 'flow_submit' };

export interface PublicPageDefinition {
  blocks: PageBlock[];
  actions: Record<string, PublicPageAction>;
}

/** web に返す形。**`hook` は返さない**（n8n の Webhook パスは利用者に見せない） */
export function toPublicPageDefinition(def: PageDefinition): PublicPageDefinition {
  const actions: Record<string, PublicPageAction> = {};
  for (const [id, action] of Object.entries(def.actions)) {
    if (action.kind === 'query') {
      actions[id] = { kind: 'query' };
    } else if (action.kind === 'flow_query' || action.kind === 'flow_submit') {
      actions[id] = { kind: action.kind };
    } else {
      const pub: PublicPageAction = { kind: 'submit' };
      if (action.confirm !== undefined) pub.confirm = action.confirm;
      if (action.refresh !== undefined) pub.refresh = [...action.refresh];
      actions[id] = pub;
    }
  }
  return { blocks: def.blocks, actions };
}

// ── 入力の検証（gateway が正、web は入力中のエラー表示） ──────────────────

/** 送信がどの部品から来たか。`blockIndex` のブロックがその action を指していなければ受け付けない */
export interface PageActionOrigin {
  blockIndex: number;
  /** buttons ブロックのときの何番目のボタンか（省略可。指定があれば一致を確かめる） */
  itemIndex?: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TEL_PATTERN = /^[0-9+\-() ]{1,30}$/;

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 項目 1 つの入力スキーマ（フォームの送信と、業務フローの部品の入力で共用） */
export function pageFieldInputSchema(field: PageField): z.ZodTypeAny {
  const required = field.required === true;
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'tel': {
      const max = field.maxLength ?? L.textInputDefault;
      const type = field.type;
      const s = z
        .string()
        .max(max, `${max} 文字までです`)
        .superRefine((v, ctx) => {
          if (hasControlChars(v, type === 'textarea')) ctx.addIssue({ code: 'custom', message: CONTROL_MSG });
          else if (type === 'email' && v !== '' && !z.string().email().safeParse(v).success) {
            ctx.addIssue({ code: 'custom', message: 'メールアドレスの形ではありません' });
          } else if (type === 'tel' && v !== '' && !TEL_PATTERN.test(v)) {
            ctx.addIssue({ code: 'custom', message: '電話番号の形ではありません' });
          }
        });
      if (required) return s.refine((v) => v.trim().length > 0, '必須です');
      return s.optional();
    }
    case 'number': {
      let n = z.number({ invalid_type_error: '数値を入れてください' }).finite();
      if (field.min !== undefined) n = n.min(field.min, `${field.min} 以上です`);
      if (field.max !== undefined) n = n.max(field.max, `${field.max} 以下です`);
      return required ? n : n.nullable().optional();
    }
    case 'date': {
      const d = z.string().refine((v) => v === '' || isValidDate(v), '日付の形ではありません');
      if (required) return d.refine((v) => v !== '', '必須です');
      return d.optional();
    }
    case 'select': {
      const values = (field.options ?? []).map((o) => o.value);
      const s = z.string().refine((v) => values.includes(v) || (!required && v === ''), '選択肢にありません');
      return required ? s : s.optional();
    }
    case 'checkbox':
      // 必須のチェックボックス＝チェックが要る（同意など）
      return required ? z.literal(true, { errorMap: () => ({ message: '必須です' }) }) : z.boolean().optional();
    default:
      return z.never();
  }
}

/**
 * submit の入力スキーマ（`.strict()`＝定義に無い項目は拒否）。設計書 §4.4・T10。
 * - form: `fields` から作る
 * - buttons: 入力なし（空オブジェクト）
 * - table の rowAction: `{ rowId: string ≤128 }`
 * `origin.blockIndex` のブロックがその submit を指していない・action が submit でないときは null（呼び出し側で 400/404）。
 */
/** buildInputSchema が読むのは blocks と actions の kind だけ（web は hook を落とした公開定義のまま渡せる） */
export interface PageInputSchemaSource {
  blocks: PageBlock[];
  actions: Record<string, { kind: PageActionKind }>;
}

export function buildInputSchema(
  definition: PageInputSchemaSource,
  actionId: string,
  origin: PageActionOrigin,
): z.ZodTypeAny | null {
  const action = Object.prototype.hasOwnProperty.call(definition.actions, actionId) ? definition.actions[actionId] : undefined;
  if (!action || !isPageSubmitKind(action.kind)) return null;
  if (!Number.isInteger(origin.blockIndex) || origin.blockIndex < 0) return null;
  const block = definition.blocks[origin.blockIndex];
  if (!block) return null;

  switch (block.type) {
    case 'form': {
      if (block.action !== actionId) return null;
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const field of block.fields) shape[field.key] = pageFieldInputSchema(field);
      return z.object(shape).strict();
    }
    case 'buttons': {
      if (origin.itemIndex !== undefined) {
        if (block.items[origin.itemIndex]?.action !== actionId) return null;
      } else if (!block.items.some((item) => item.action === actionId)) {
        return null;
      }
      return z.object({}).strict();
    }
    case 'table':
      // 行の操作は n8n の submit だけ（flow_submit はフローのきっかけの項目を送る）
      if (block.rowAction?.action !== actionId || action.kind !== 'submit') return null;
      return z
        .object({
          rowId: z
            .string()
            .min(1)
            .max(L.rowIdMax)
            .refine((v) => !hasControlChars(v), CONTROL_MSG),
        })
        .strict();
    default:
      return null;
  }
}

// ── n8n の応答の切り詰め（K12） ────────────────────────────────

export type PageCell = string | number | boolean | null;

export interface PageRow {
  /** rowKey の値（文字列にそろえる）。無い・スカラーでない行は null（行の操作を出さない） */
  id: string | null;
  /** 宣言された列（list は titleKey / subKey / metaKey）だけ */
  cells: Record<string, PageCell>;
}

export type ProjectedBlock =
  | { index: number; type: 'kpi'; values: Record<number, string | number | null> }
  | { index: number; type: 'table' | 'list'; rows: PageRow[]; truncated: boolean }
  | { index: number; type: 'kpi' | 'table' | 'list'; error: 'INVALID_RESPONSE' };

export interface ProjectedQueryResult {
  action: string;
  /** その action を参照するブロックだけ。ブロック単位で error になりうる（他のブロックは出す） */
  blocks: ProjectedBlock[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownValue(obj: Record<string, unknown>, key: string): { has: boolean; value: unknown } {
  return Object.prototype.hasOwnProperty.call(obj, key) ? { has: true, value: obj[key] } : { has: false, value: undefined };
}

/** 文字列は上限で切り、制御文字は空白に置き換える（改行も 1 行の表示では空白に） */
function clipText(value: string, max: number): string {
  let out = '';
  for (const ch of value) {
    if (out.length >= max) break;
    out += hasControlChars(ch) ? ' ' : ch;
  }
  return out.length > max ? out.slice(0, max) : out;
}

/** セル: string / number / boolean / null だけ。オブジェクト・配列・非有限の数は null に落とす */
function toCell(value: unknown): PageCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clipText(value, L.cellMax);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

function toRowId(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 && value.length <= L.rowIdMax && !hasControlChars(value) ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function projectRows(
  raw: Record<string, unknown>,
  sourceKey: string,
  keys: string[],
  rowKey: string | undefined,
  maxRows: number,
): { rows: PageRow[]; truncated: boolean } | null {
  const { has, value } = ownValue(raw, sourceKey);
  if (!has || !Array.isArray(value)) return null;
  const rows: PageRow[] = [];
  let truncated = false;
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const cells: Record<string, PageCell> = {};
    for (const key of keys) cells[key] = toCell(ownValue(item, key).value);
    rows.push({ id: rowKey ? toRowId(ownValue(item, rowKey).value) : null, cells });
  }
  return { rows, truncated };
}

/**
 * n8n の query の応答を、その action を参照するブロックの形に照らして検証・切り詰める（設計書 §4.4）。
 * - 返すのは**宣言された key と列だけ**。それ以外は捨てる
 * - セルはスカラーだけ（ネストは null）。文字列は上限で切る。行数は上限で切り `truncated: true`
 * - 必須の key が無い・型が違うブロックは、そのブロックだけ `{ error: 'INVALID_RESPONSE' }`
 * - 文字列は HTML として扱わない（`<script>` もただの文字）。描画側がテキストノードで出す
 */
export function projectQueryResult(definition: PageDefinition, actionId: string, raw: unknown): ProjectedQueryResult {
  const obj = isPlainObject(raw) ? raw : null;
  const blocks: ProjectedBlock[] = [];

  definition.blocks.forEach((block, index) => {
    switch (block.type) {
      case 'kpi': {
        const items = block.items.map((item, i) => ({ item, i })).filter(({ item }) => item.source.action === actionId);
        if (items.length === 0) return;
        if (!obj) {
          blocks.push({ index, type: 'kpi', error: 'INVALID_RESPONSE' });
          return;
        }
        const values: Record<number, string | number | null> = {};
        for (const { item, i } of items) {
          const { has, value } = ownValue(obj, item.source.key);
          if (!has) {
            blocks.push({ index, type: 'kpi', error: 'INVALID_RESPONSE' });
            return;
          }
          if (value === null) values[i] = null;
          else if (typeof value === 'number' && Number.isFinite(value)) values[i] = value;
          else if (typeof value === 'string') values[i] = clipText(value, L.kpiTextMax);
          else {
            blocks.push({ index, type: 'kpi', error: 'INVALID_RESPONSE' });
            return;
          }
        }
        blocks.push({ index, type: 'kpi', values });
        return;
      }
      case 'table':
      case 'list': {
        if (block.source.action !== actionId) return;
        const keys =
          block.type === 'table'
            ? block.columns.map((c) => c.key)
            : [block.titleKey, block.subKey, block.metaKey].filter((k): k is string => typeof k === 'string');
        const rowKey = block.type === 'table' ? block.rowKey : undefined;
        const max = block.type === 'table' ? L.tableRowsMax : L.listRowsMax;
        const projected = obj ? projectRows(obj, block.source.key, [...new Set(keys)], rowKey, max) : null;
        blocks.push(
          projected ? { index, type: block.type, ...projected } : { index, type: block.type, error: 'INVALID_RESPONSE' },
        );
        return;
      }
      default:
        return;
    }
  });

  return { action: actionId, blocks };
}

// ── n8n の submit 応答（§5.2 の 10） ───────────────────────────────

/** submit の応答は `{ ok, message? }` だけ受け取り、他のキーは捨てる（strip） */
export const pageSubmitResponseSchema = z.object({
  ok: z.boolean(),
  message: z
    .string()
    .transform((v) => clipText(v, L.submitMessageMax))
    .optional(),
});
export type PageSubmitResponse = z.infer<typeof pageSubmitResponseSchema>;
