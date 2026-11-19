// 業務フローとホームキャンバスの作成・保存・削除（docs/design/canvas-home.md §5.2・§5.3・§7.1）。
//
// ■ 版
//   定義を正規化した sha256（definitionHash）が変わったときだけ version を +1 し、FlowVersion を 1 行足して
//   直近 20 版より古いものを消す（同じトランザクション）。位置（layout）・名前などだけの変更では版は上がらない（K16）。
//   保存は baseVersion を条件にした updateMany。違えば 409 FLOW_CONFLICT（他人の変更を上書きしない。T18）。
// ■ テンプレートから作る（K4）
//   定義をそのまま複製する（LLM も乱数も使わない）。slug はテンプレートで決まる値なので、2 人が同時に押しても
//   @@unique([orgId, slug]) で 1 つ。負けた側は P2002 → 既存を返す（created: false）。
//   キャンバスのノードの行き先を flow に書き換えるのも同じトランザクション（キャンバスの版が動いていたら書き換えだけ諦める）。
// ■ 上限
//   新規作成だけ canAddFlow で断る（403 FLOW_LIMIT_REACHED）。既存の編集は上限を超えていても通す（降格しても消さない）。
// ■ 監査
//   meta は { flowId, slug, version }（＋変えた項目名）だけ。定義の中身は入れない（§7.5）。
// ■ 定期
//   きっかけが「定期」のフローは、作成・保存と同じトランザクションで ScheduledTask を 1 行 upsert（やめたら消す。schedule.ts）。
//   有効/無効と名前も写す。発火は schedule-dispatcher が flowId を見てランナーへ渡す。
// ■ 結果ページ
//   定義・役割が変わったら、同じトランザクションで結果ページ（CustomPage source='FLOW'）を写し直す（page-sync.ts）。
//
// ⚠️ ルートは定義・配置を shared-types のスキーマに通してから渡すこと。ここで n8n の public API は呼ばない（D9・T22）。

import {
  DEFAULT_PAGE_ICON,
  FLOW_RUN_LIMITS,
  FLOW_SCHEMA_VERSION,
  FLOW_TEMPLATE_SLUGS,
  canvasLayoutSchema,
  cloneFlowTemplate,
  defaultCanvasLayout,
  emptyFlowDefinition,
  flowMobileTextKeys,
  flowTemplateSlug,
  isFlowTemplateKey,
  type CanvasLayout,
  type CanvasTarget,
  type FlowDefinition,
  type FlowLayout,
  type FlowTemplateKey,
  type PageIcon,
  type UserRole,
} from '@org-ai/shared-types';
import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import type { TenantDb, TenantTx } from '../../tenancy/tenant-db';
import { recordAudit } from '../audit';
import { canonicalHashOf } from '../pages/upsert';
import { canCreateFlow } from './limits';
import { syncFlowSchedule } from './schedule';
import { syncFlowPage } from './page-sync';
import { canViewFlow } from './access';

/** ルートが sendError にそのまま渡せる失敗 */
export class FlowServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FlowServiceError';
  }
}

const LIMIT_MESSAGE = 'ご契約のプランで作れるフロー数の上限に達しています。プランを上げるか、使っていないフローを削除してください。';
const FLOW_NOT_FOUND_MESSAGE = 'フローが見つかりません';
const CONFLICT_MESSAGE = '別の人が先に保存しました。画面を開き直してから、もう一度変更してください。';

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2002';
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

export const FLOW_SELECT = {
  id: true,
  slug: true,
  name: true,
  icon: true,
  enabled: true,
  minRole: true,
  templateKey: true,
  templateVersion: true,
  version: true,
  definition: true,
  definitionHash: true,
  layout: true,
  updatedAt: true,
} as const;

export interface FlowRow {
  id: string;
  slug: string;
  name: string;
  icon: string;
  enabled: boolean;
  minRole: string;
  templateKey: string | null;
  templateVersion: number | null;
  version: number;
  definition: unknown;
  definitionHash: string;
  layout: unknown;
  updatedAt: Date;
}

/** 定義に無いノードの位置は捨てる（消したノードの位置が残り続けない） */
export function pickFlowLayout(layout: FlowLayout, definition: FlowDefinition): FlowLayout {
  const ids = new Set(definition.nodes.map((n) => n.id));
  return Object.fromEntries(Object.entries(layout).filter(([id]) => ids.has(id)));
}

// ── キャンバス ───────────────────────────────────────────────

export interface CanvasState {
  layout: CanvasLayout;
  /** 行が無い（既定の配置）ときは 0 */
  version: number;
  isDefault: boolean;
}

/** 保存済みの配置。行が無い・壊れている（スキーマが厳しくなった後の古い行）ときは既定の配置 */
export async function loadCanvas(db: Pick<TenantTx, 'orgId' | 'canvas'>): Promise<CanvasState & { exists: boolean }> {
  const row = await db.canvas.findUnique({ where: { orgId: db.orgId }, select: { layout: true, version: true } });
  if (!row) return { layout: defaultCanvasLayout(), version: 0, isDefault: true, exists: false };
  const parsed = canvasLayoutSchema.safeParse(row.layout);
  return {
    layout: parsed.success ? parsed.data : defaultCanvasLayout(),
    version: row.version,
    isDefault: !parsed.success,
    exists: true,
  };
}

/**
 * 1 つのノードの行き先を書き換える（テンプレートから作った・フローを消した）。
 * `match` を満たすノードが無い、またはキャンバスの版が動いていたら何もしない（false）。行が無ければ既定の配置で作る。
 */
async function retargetCanvasNodes(
  tx: TenantTx,
  match: (node: CanvasLayout['nodes'][number]) => boolean,
  target: CanvasTarget,
  actorId: string | null,
): Promise<boolean> {
  const current = await loadCanvas(tx);
  let hit = false;
  const nodes = current.layout.nodes.map((n) => {
    if (!match(n)) return n;
    hit = true;
    return { ...n, target };
  });
  if (!hit) return false;
  const layout = json({ ...current.layout, nodes });
  if (!current.exists) {
    await tx.canvas.create({ data: { orgId: tx.orgId, layout, version: 1, updatedBy: actorId } });
    return true;
  }
  const res = await tx.canvas.updateMany({
    where: { version: current.version },
    data: { layout, version: current.version + 1, updatedBy: actorId },
  });
  return res.count > 0;
}

/**
 * キャンバスの保存（PUT /api/canvas）。`baseVersion` は GET が返した版（行が無ければ 0）。
 * 違えば 409 CANVAS_CONFLICT。`flow` の行き先が自組織のフローかを確かめる（他組織・存在しない id は 400。T1）。
 */
export async function saveCanvas(
  db: TenantDb,
  args: { layout: CanvasLayout; baseVersion: number; actorId: string | null },
): Promise<{ version: number; changed: boolean }> {
  const flowIds = [
    ...new Set(args.layout.nodes.flatMap((n) => (n.target.kind === 'flow' ? [n.target.flowId] : []))),
  ];
  if (flowIds.length > 0) {
    const found = await db.flow.findMany({ where: { id: { in: flowIds } }, select: { id: true } });
    if (found.length !== flowIds.length) {
      throw new FlowServiceError(400, 'CANVAS_INVALID_TARGET', '存在しないフローを指すノードがあります。画面を開き直してください。');
    }
  }

  const current = await loadCanvas(db);
  if (current.version !== args.baseVersion) throw new FlowServiceError(409, 'CANVAS_CONFLICT', CONFLICT_MESSAGE);
  if (current.exists && canonicalHashOf(current.layout) === canonicalHashOf(args.layout)) {
    return { version: current.version, changed: false };
  }

  let version: number;
  if (!current.exists) {
    try {
      await db.canvas.create({ data: { orgId: db.orgId, layout: json(args.layout), version: 1, updatedBy: args.actorId } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new FlowServiceError(409, 'CANVAS_CONFLICT', CONFLICT_MESSAGE);
      throw e;
    }
    version = 1;
  } else {
    const res = await db.canvas.updateMany({
      where: { version: args.baseVersion },
      data: { layout: json(args.layout), version: args.baseVersion + 1, updatedBy: args.actorId },
    });
    if (res.count === 0) throw new FlowServiceError(409, 'CANVAS_CONFLICT', CONFLICT_MESSAGE);
    version = args.baseVersion + 1;
  }
  await recordAudit(db, { action: 'canvas.update', actorId: args.actorId, targetType: 'canvas', targetId: null, meta: { version } });
  return { version, changed: true };
}

// ── フローの作成 ─────────────────────────────────────────────

export interface CreateFlowResult {
  flow: FlowRow;
  created: boolean;
  /** キャンバスのノードを flow に書き換えたか */
  canvasUpdated: boolean;
}

async function findBySlug(db: Pick<TenantTx, 'orgId' | 'flow'>, slug: string): Promise<FlowRow | null> {
  return (await db.flow.findUnique({
    where: { orgId_slug: { orgId: db.orgId, slug } },
    select: FLOW_SELECT,
  })) as FlowRow | null;
}

/**
 * テンプレートからフローを作る（POST /api/flows/from-template）。既にあればそれを返す（created: false）。
 * `canvasNodeId` を渡すと、そのノード（行き先が同じテンプレート、またはこのフロー）の行き先を flow に書き換える。
 */
export async function createFlowFromTemplate(
  db: TenantDb,
  args: { templateKey: FlowTemplateKey; canvasNodeId?: string; plan: string; actorId: string | null; role: UserRole | null },
  retried = false,
): Promise<CreateFlowResult> {
  const slug = flowTemplateSlug(args.templateKey);
  const nodeMatches = (flowId: string) => (n: CanvasLayout['nodes'][number]) =>
    n.id === args.canvasNodeId &&
    ((n.target.kind === 'template' && n.target.templateKey === args.templateKey) ||
      (n.target.kind === 'flow' && n.target.flowId === flowId));

  const existing = await findBySlug(db, slug);
  if (existing) {
    // 自分より上の役割限定のフローなら、キャンバスを書き換える前に 404（存在を漏らさない・意図しない変更をしない）
    if (!canViewFlow(existing, args.role)) throw new FlowServiceError(404, 'NOT_FOUND', FLOW_NOT_FOUND_MESSAGE);
    let canvasUpdated = false;
    if (args.canvasNodeId) {
      canvasUpdated = await db.$transaction((tx) =>
        retargetCanvasNodes(tx, nodeMatches(existing.id), { kind: 'flow', flowId: existing.id }, args.actorId),
      );
    }
    return { flow: existing, created: false, canvasUpdated };
  }
  if (!(await canCreateFlow(db, args.plan, slug))) throw new FlowServiceError(403, 'FLOW_LIMIT_REACHED', LIMIT_MESSAGE);

  const tpl = cloneFlowTemplate(args.templateKey);
  try {
    const result = await db.$transaction(async (tx) => {
      const flow = (await tx.flow.create({
        data: {
          orgId: tx.orgId,
          slug,
          name: tpl.name,
          icon: tpl.icon,
          templateKey: tpl.key,
          templateVersion: tpl.version,
          version: 1,
          schemaVersion: FLOW_SCHEMA_VERSION,
          definition: json(tpl.definition),
          definitionHash: canonicalHashOf(tpl.definition),
          layout: json(tpl.layout),
          createdBy: args.actorId,
          updatedBy: args.actorId,
        },
        select: FLOW_SELECT,
      })) as FlowRow;
      await tx.flowVersion.create({
        data: { flowId: flow.id, version: 1, definition: json(tpl.definition), createdBy: args.actorId },
      });
      await syncFlowSchedule(tx, flow, tpl.definition);
      const canvasUpdated = args.canvasNodeId
        ? await retargetCanvasNodes(tx, nodeMatches(flow.id), { kind: 'flow', flowId: flow.id }, args.actorId)
        : false;
      return { flow, canvasUpdated };
    });
    await recordAudit(db, {
      action: 'flow.create',
      actorId: args.actorId,
      targetType: 'flow',
      targetId: result.flow.id,
      meta: { flowId: result.flow.id, slug, version: 1 },
    });
    return { ...result, created: true };
  } catch (e) {
    // 同時に押された（フローの slug か、キャンバスの行の作成がぶつかった）。先に入った方を返す＝1 回だけやり直す
    if (isUniqueViolation(e) && !retried) return createFlowFromTemplate(db, args, true);
    throw e;
  }
}

/** 手作りのフローの slug（指定が無いとき）。英小文字・数字・ハイフン */
function generatedSlug(): string {
  return `f-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** 空のフロー（きっかけ → 出力）を作る（POST /api/flows） */
export async function createEmptyFlow(
  db: TenantDb,
  args: { name: string; icon?: PageIcon; slug?: string; minRole?: UserRole; plan: string; actorId: string | null },
): Promise<FlowRow> {
  const slug = args.slug ?? generatedSlug();
  if (FLOW_TEMPLATE_SLUGS.includes(slug)) {
    throw new FlowServiceError(400, 'VALIDATION_ERROR', `slug「${slug}」はテンプレート用です。別の slug にしてください。`);
  }
  if (!(await canCreateFlow(db, args.plan))) throw new FlowServiceError(403, 'FLOW_LIMIT_REACHED', LIMIT_MESSAGE);
  const { definition, layout } = emptyFlowDefinition();
  try {
    const flow = await db.$transaction(async (tx) => {
      const row = (await tx.flow.create({
        data: {
          orgId: tx.orgId,
          slug,
          name: args.name,
          icon: args.icon ?? DEFAULT_PAGE_ICON,
          minRole: args.minRole ?? 'MEMBER',
          version: 1,
          schemaVersion: FLOW_SCHEMA_VERSION,
          definition: json(definition),
          definitionHash: canonicalHashOf(definition),
          layout: json(layout),
          createdBy: args.actorId,
          updatedBy: args.actorId,
        },
        select: FLOW_SELECT,
      })) as FlowRow;
      await tx.flowVersion.create({ data: { flowId: row.id, version: 1, definition: json(definition), createdBy: args.actorId } });
      await syncFlowSchedule(tx, row, definition);
      return row;
    });
    await recordAudit(db, {
      action: 'flow.create',
      actorId: args.actorId,
      targetType: 'flow',
      targetId: flow.id,
      meta: { flowId: flow.id, slug, version: 1 },
    });
    return flow;
  } catch (e) {
    if (isUniqueViolation(e)) throw new FlowServiceError(409, 'FLOW_SLUG_TAKEN', `slug「${slug}」は使われています`);
    throw e;
  }
}

// ── フローの保存 ─────────────────────────────────────────────

export interface FlowFieldChanges {
  name?: string;
  icon?: PageIcon;
  minRole?: UserRole;
  enabled?: boolean;
}

export interface WriteFlowArgs {
  flow: FlowRow;
  /** 呼び出し側でスキーマに通したもの。無ければ定義は変えない */
  definition?: FlowDefinition;
  layout?: FlowLayout;
  fields: FlowFieldChanges;
  /** この版を前提に書く。違えば 409 FLOW_CONFLICT */
  baseVersion: number;
  actorId: string | null;
}

export interface WriteFlowResult {
  version: number;
  changed: boolean;
  /** 変えた項目名（definition / layout / name / icon / minRole / enabled） */
  changedFields: string[];
}

/** 保存の本体（PUT と PATCH が通る） */
export async function writeFlow(db: TenantDb, args: WriteFlowArgs): Promise<WriteFlowResult> {
  const { flow, actorId } = args;
  if (args.baseVersion !== flow.version) throw new FlowServiceError(409, 'FLOW_CONFLICT', CONFLICT_MESSAGE);

  const hash = args.definition ? canonicalHashOf(args.definition) : flow.definitionHash;
  const definitionChanged = hash !== flow.definitionHash;
  const layout = args.layout && args.definition ? pickFlowLayout(args.layout, args.definition) : args.layout;
  const layoutChanged = layout !== undefined && canonicalHashOf(layout) !== canonicalHashOf(flow.layout ?? {});
  const fieldChanges = Object.fromEntries(
    Object.entries(args.fields).filter(([k, v]) => v !== undefined && v !== (flow as unknown as Record<string, unknown>)[k]),
  ) as FlowFieldChanges;
  const changedFields = [
    ...(definitionChanged ? ['definition'] : []),
    ...(layoutChanged ? ['layout'] : []),
    ...Object.keys(fieldChanges),
  ];
  if (changedFields.length === 0) return { version: flow.version, changed: false, changedFields };

  const version = definitionChanged ? flow.version + 1 : flow.version;
  await db.$transaction(async (tx) => {
    const res = await tx.flow.updateMany({
      where: { id: flow.id, version: flow.version },
      data: {
        ...fieldChanges,
        ...(layoutChanged ? { layout: json(layout) } : {}),
        ...(definitionChanged
          ? { definition: json(args.definition), definitionHash: hash, version, schemaVersion: FLOW_SCHEMA_VERSION }
          : {}),
        updatedBy: actorId,
      },
    });
    if (res.count === 0) throw new FlowServiceError(409, 'FLOW_CONFLICT', CONFLICT_MESSAGE);
    if (definitionChanged) {
      // 親（flow）はテナントクライアントで取れている（不変条件 I2）
      await tx.flowVersion.create({ data: { flowId: flow.id, version, definition: json(args.definition), createdBy: actorId } });
      await tx.flowVersion.deleteMany({ where: { flowId: flow.id, version: { lte: version - FLOW_RUN_LIMITS.versionsKept } } });
    }
    // 定期のきっかけ（定義・有効/無効・名前のどれかが変わったら写す）。定義が壊れた古い行は定期を作らない
    if (definitionChanged || fieldChanges.enabled !== undefined || fieldChanges.name !== undefined) {
      const def = (args.definition ?? flow.definition) as FlowDefinition | null;
      await syncFlowSchedule(
        tx,
        { id: flow.id, name: fieldChanges.name ?? flow.name, enabled: fieldChanges.enabled ?? flow.enabled },
        def && Array.isArray((def as { nodes?: unknown }).nodes) ? def : { nodes: [] },
      );
    }
    // 結果ページ: フォームの項目をきっかけに合わせ、役割をフローより下にしない（§3.5）
    if ((definitionChanged && args.definition) || fieldChanges.minRole !== undefined) {
      await syncFlowPage(tx, flow.id, { definition: definitionChanged ? args.definition : undefined, minRole: fieldChanges.minRole });
    }
  });

  const meta = { flowId: flow.id, slug: flow.slug, version, changed: changedFields };
  if (changedFields.some((f) => f !== 'enabled')) {
    await recordAudit(db, { action: 'flow.update', actorId, targetType: 'flow', targetId: flow.id, meta });
  }
  if (fieldChanges.enabled !== undefined) {
    await recordAudit(db, {
      action: fieldChanges.enabled ? 'flow.enable' : 'flow.disable',
      actorId,
      targetType: 'flow',
      targetId: flow.id,
      meta: { flowId: flow.id, slug: flow.slug, version },
    });
  }
  return { version, changed: true, changedFields };
}

/** スマホの簡単な変更（PATCH の node）。構造は変えず、1 ノードのラベルと既存の文字項目だけ差し替える */
export interface NodeTextPatch {
  id: string;
  label?: string;
  config?: Record<string, string>;
}

/** 差し替えた定義（検証は呼び出し側でスキーマに通す）。差し替えられない項目は FlowServiceError(400) */
export function applyNodeTextPatch(definition: FlowDefinition, patch: NodeTextPatch): FlowDefinition {
  const next = JSON.parse(JSON.stringify(definition)) as FlowDefinition;
  const node = next.nodes.find((n) => n.id === patch.id);
  if (!node) throw new FlowServiceError(400, 'VALIDATION_ERROR', 'ノードがありません');
  if (patch.label !== undefined) node.label = patch.label;
  const config = node.config as Record<string, unknown>;
  // 型ごとの許可リスト（K76: AI の指示・確認の文言と見せる内容・文書の題名と本文・通知の本文だけ。宛先・式・参照は PC）
  const allowed = flowMobileTextKeys(node);
  for (const [key, value] of Object.entries(patch.config ?? {})) {
    // 既にある文字の項目だけ（項目を足す・型を変える＝構造の変更はフロー画面で）
    if (!allowed.includes(key) || !Object.prototype.hasOwnProperty.call(config, key) || typeof config[key] !== 'string') {
      throw new FlowServiceError(400, 'VALIDATION_ERROR', `"${key}" はここでは変えられません`);
    }
    config[key] = value;
  }
  return next;
}

// ── 削除 ───────────────────────────────────────────────────

/**
 * フロー・版・定期・結果ページを消す（同じトランザクション。FK の Cascade でも消えるが明示する）。実行履歴（FlowRun）は残す（K25）。
 * キャンバスでこのフローを指すノードは、テンプレート由来ならテンプレートに戻す（もう一度押せば作り直せる）。
 */
export async function deleteFlow(db: TenantDb, args: { flow: FlowRow; actorId: string | null }): Promise<boolean> {
  const { flow, actorId } = args;
  const deleted = await db.$transaction(async (tx) => {
    await tx.customPage.deleteMany({ where: { flowId: flow.id } });
    await tx.scheduledTask.deleteMany({ where: { flowId: flow.id } });
    await tx.flowVersion.deleteMany({ where: { flowId: flow.id } });
    const res = await tx.flow.deleteMany({ where: { id: flow.id } });
    if (res.count === 0) return false;
    if (isFlowTemplateKey(flow.templateKey)) {
      await retargetCanvasNodes(
        tx,
        (n) => n.target.kind === 'flow' && n.target.flowId === flow.id,
        { kind: 'template', templateKey: flow.templateKey },
        actorId,
      );
    }
    return true;
  });
  if (deleted) {
    await recordAudit(db, {
      action: 'flow.delete',
      actorId,
      targetType: 'flow',
      targetId: flow.id,
      meta: { flowId: flow.id, slug: flow.slug, version: flow.version },
    });
  }
  return deleted;
}
