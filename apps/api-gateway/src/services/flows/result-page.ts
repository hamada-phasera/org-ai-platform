// 業務フローの結果ページ（docs/design/canvas-home.md §3.5・§6.3）。出力ビルダーの保存と、`/p/:slug` の flow_query / flow_submit。
//
// ■ ページ
//   `CustomPage(source='FLOW', flowId)`。フロー 1 つに 1 ページ（flowId は @unique）。ページ数の上限には数えない（K15）。
//   slug はフローの slug（使われていれば `<slug>-out`）。作ったときは公開済み・見られる役割はフローと同じ（K80）。
//   公開・並び・役割は既存の 設定 > 業務ページ（PATCH）で変える。定義は出力ビルダーだけが書く（手動 upsert・n8n の登録は 409）。
// ■ 定義
//   読む側の `pageDefinitionSchema`（flow_* を許す）→ `alignFlowPageDefinition`（フォーム＝きっかけの項目）→
//   `checkFlowPageDefinition`（データのキーと列がフローの出力にあるか）。フローを保存すると同じトランザクションで写し直す。
// ■ 実行（flow_submit）
//   そのページの flowId のフローだけを、手の実行と同じ `acceptRun` で受け付ける（上限・未接続・入力の検査）。
//   **フローの実行として 1 回だけ数える**（PageActionLog には書かない。K15・§6.3）。n8n は呼ばない。
// ■ 読む（flow_query）
//   直近の成功した実行の output と、履歴（保持期間の中の直近 50 回）を projectQueryResult で切り詰めて返す。
//
// ⚠️ ここで n8n の public API は呼ばない（D9・T22）。ログに値は出さない。

import {
  FLOW_PAGE_RUNS_MAX,
  FLOW_PARTS,
  PAGE_SCHEMA_VERSION,
  alignFlowPageDefinition,
  buildInputSchema,
  checkFlowPageDefinition,
  flowDefinitionSchema,
  flowHistoryCutoff,
  flowQueryRaw,
  isFlowRunFinal,
  isReservedPageSlug,
  pageDefinitionSchema,
  projectQueryResult,
  type FlowDefinition,
  type FlowPageIssue,
  type PageDefinition,
  type ProjectedQueryResult,
  type UserRole,
} from '@org-ai/shared-types';
import type { Prisma } from '@prisma/client';
import type { TenantDb, TenantTx } from '../../tenancy/tenant-db';
import { createLogger } from '../../utils/logger';
import { recordAudit } from '../audit';
import { canonicalHashOf, describeIssues } from '../pages/upsert';
import { canViewFlow } from './access';
import { FLOW_SELECT, FlowServiceError, type FlowRow } from './store';
import { FlowRunInputError, acceptRun, flowQueueTuning, pumpOrg } from './queue';
import { waitForRunSettled } from './runner';
import { loadFlowPage } from './page-sync';

export { FLOW_PAGE_SELECT, loadFlowPage, syncFlowPage, type FlowPageRow } from './page-sync';

const log = createLogger('flows');

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** 検査で落ちたとき（ルートが 400 FLOW_PAGE_INVALID に issues を付けて返す） */
export class FlowPageInvalidError extends Error {
  constructor(readonly issues: FlowPageIssue[]) {
    super(describeIssues(issues));
    this.name = 'FlowPageInvalidError';
  }
}

const CONFLICT = () => new FlowServiceError(409, 'FLOW_PAGE_CONFLICT', '他の人が先に保存しました。開き直してから保存してください');

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function parsedFlowDefinition(flow: { definition: unknown }): FlowDefinition | null {
  const r = flowDefinitionSchema.safeParse(flow.definition);
  return r.success ? (r.data as FlowDefinition) : null;
}

/** 保存する定義を作る（検証 → きっかけに合わせる → 出力の検査）。失敗は FlowPageInvalidError */
export function prepareFlowPageDefinition(raw: unknown, def: FlowDefinition): PageDefinition {
  const parsed = pageDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new FlowPageInvalidError(parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
  const aligned = alignFlowPageDefinition(parsed.data, def);
  const again = pageDefinitionSchema.safeParse(aligned);
  if (!again.success) throw new FlowPageInvalidError(again.error.issues.map((i) => ({ path: i.path, message: i.message })));
  const issues = checkFlowPageDefinition(aligned, def, FLOW_PARTS);
  if (issues.length > 0) throw new FlowPageInvalidError(issues);
  return aligned;
}

/** まだ使われていない slug（フローの slug → `<slug>-out`）。どちらも使われていれば null */
async function freeSlugFor(db: Pick<TenantTx, 'customPage'>, flowSlug: string): Promise<string | null> {
  const candidates = [flowSlug, `${flowSlug.slice(0, 36).replace(/-+$/, '')}-out`];
  for (const slug of candidates) {
    if (isReservedPageSlug(slug)) continue;
    const taken = await db.customPage.findFirst({ where: { slug }, select: { id: true } });
    if (!taken) return slug;
  }
  return null;
}

export interface SaveFlowPageArgs {
  flow: FlowRow;
  definition: unknown;
  title?: string;
  /** 既にページがあるときは必須（他人の保存を上書きしない） */
  baseVersion?: number;
  actorId: string;
}

export interface SaveFlowPageResult {
  slug: string;
  version: number;
  status: string;
  created: boolean;
  changed: boolean;
}

/** 出力ビルダーの保存。ページが無ければ作る（公開済み・役割はフローと同じ） */
export async function saveFlowPage(db: TenantDb, args: SaveFlowPageArgs): Promise<SaveFlowPageResult> {
  const { flow, actorId } = args;
  const def = parsedFlowDefinition(flow);
  if (!def) throw new FlowServiceError(409, 'FLOW_INVALID_DEFINITION', 'フローの定義が古い形です。手順を直して保存してから出力を作ってください');
  const definition = prepareFlowPageDefinition(args.definition, def);
  const hash = canonicalHashOf(definition);
  const existing = await loadFlowPage(db, flow.id);

  if (!existing) {
    const slug = await freeSlugFor(db, flow.slug);
    if (!slug) throw new FlowServiceError(409, 'PAGE_SLUG_TAKEN', '同じ名前の業務ページがあるため作れません。そのページの slug を変えてください');
    try {
      const created = await db.customPage.create({
        data: {
          orgId: db.orgId,
          slug,
          title: args.title ?? flow.name,
          icon: flow.icon,
          sortOrder: 0,
          status: 'PUBLISHED',
          minRole: flow.minRole,
          source: 'FLOW',
          flowId: flow.id,
          version: 1,
          schemaVersion: PAGE_SCHEMA_VERSION,
          definition: json(definition),
          definitionHash: hash,
          adminEditedFields: [],
          createdBy: actorId,
          updatedBy: actorId,
        },
        select: { id: true, slug: true, version: true, status: true },
      });
      await recordAudit(db, {
        action: 'page.upsert',
        actorId,
        targetType: 'custom_page',
        targetId: created.id,
        meta: { slug, version: 1, status: created.status, source: 'FLOW', flowId: flow.id },
      });
      return { slug: created.slug, version: created.version, status: created.status, created: true, changed: true };
    } catch (e) {
      // 同じフローのページを 2 人が同時に作った（flowId の unique）か、同じ slug が同時にできた
      if (isUniqueViolation(e)) throw CONFLICT();
      throw e;
    }
  }

  if (args.baseVersion !== existing.version) throw CONFLICT();
  const title = args.title ?? existing.title;
  if (existing.definitionHash === hash && title === existing.title) {
    return { slug: existing.slug, version: existing.version, status: existing.status, created: false, changed: false };
  }
  const definitionChanged = existing.definitionHash !== hash;
  const version = definitionChanged ? existing.version + 1 : existing.version;
  const res = await db.customPage.updateMany({
    where: { id: existing.id, version: existing.version },
    data: {
      title,
      version,
      ...(definitionChanged ? { definition: json(definition), definitionHash: hash, schemaVersion: PAGE_SCHEMA_VERSION } : {}),
      updatedBy: actorId,
    },
  });
  if (res.count === 0) throw CONFLICT();
  await recordAudit(db, {
    action: 'page.upsert',
    actorId,
    targetType: 'custom_page',
    targetId: existing.id,
    meta: { slug: existing.slug, version, status: existing.status, source: 'FLOW', flowId: flow.id, changed: definitionChanged ? ['definition'] : ['title'] },
  });
  return { slug: existing.slug, version, status: existing.status, created: false, changed: true };
}

// ── /p/:slug のアクション ─────────────────────────────────────

export type FlowActionOutcome<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string; issues?: unknown };

const NOT_FOUND = { ok: false as const, status: 404, code: 'NOT_FOUND', message: 'ページが見つかりません' };

/** ページの flowId のフロー。同じ組織（テナントクライアント）で取れ、役割が足りるときだけ */
async function flowOfPage(db: TenantDb, flowId: string | null, role: UserRole | null): Promise<FlowRow | null> {
  if (!flowId) return null;
  const flow = (await db.flow.findUnique({ where: { id: flowId }, select: FLOW_SELECT })) as FlowRow | null;
  return flow && canViewFlow(flow, role) ? flow : null;
}

export async function runFlowPageQuery(args: {
  db: TenantDb;
  role: UserRole | null;
  flowId: string | null;
  definition: PageDefinition;
  actionId: string;
  plan: string;
}): Promise<FlowActionOutcome<ProjectedQueryResult>> {
  const { db } = args;
  const flow = await flowOfPage(db, args.flowId, args.role);
  if (!flow) return NOT_FOUND;
  const def = parsedFlowDefinition(flow) ?? ({ nodes: [], edges: [] } as unknown as FlowDefinition);
  const since = flowHistoryCutoff(args.plan, new Date());
  const [latest, runs] = await Promise.all([
    db.flowRun.findFirst({
      where: { flowId: flow.id, status: 'SUCCEEDED', createdAt: { gte: since } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { output: true },
    }),
    db.flowRun.findMany({
      where: { flowId: flow.id, createdAt: { gte: since } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FLOW_PAGE_RUNS_MAX,
      select: { createdAt: true, status: true, output: true },
    }),
  ]);
  const raw = flowQueryRaw(def, (latest?.output ?? null) as Record<string, unknown> | null, runs);
  return { ok: true, data: projectQueryResult(args.definition, args.actionId, raw) };
}

export interface FlowPageSubmitData {
  ok: boolean;
  message: string;
  sample: false;
  runId: string;
  status: string;
}

const SUBMIT_MESSAGE: Record<string, string> = {
  SUCCEEDED: '完了しました',
  WAITING_APPROVAL: '承認待ちです。受信で承認すると続きます',
  QUEUED: '受け付けました。結果は少し後に出ます',
  RUNNING: '受け付けました。結果は少し後に出ます',
};

export async function runFlowPageSubmit(args: {
  db: TenantDb;
  role: UserRole | null;
  userId: string;
  flowId: string | null;
  definition: PageDefinition;
  actionId: string;
  input: unknown;
  requestId: string;
  origin: { blockIndex: number; itemIndex?: number };
  plan: string;
}): Promise<FlowActionOutcome<FlowPageSubmitData>> {
  const { db } = args;
  const flow = await flowOfPage(db, args.flowId, args.role);
  if (!flow) return NOT_FOUND;
  const inputSchema = buildInputSchema(args.definition, args.actionId, args.origin);
  if (!inputSchema) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: '送信元の部品がこの操作と合いません' };
  const input = inputSchema.safeParse(args.input);
  if (!input.success) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: describeIssues(input.error.issues) };

  let accepted: { runId: string };
  try {
    accepted = await acceptRun(db, {
      flow,
      input: input.data as Record<string, unknown>,
      requestId: args.requestId,
      trigger: 'page',
      actorId: args.userId,
      plan: args.plan,
    });
  } catch (e) {
    if (e instanceof FlowRunInputError) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: e.message, issues: e.issues };
    if (e instanceof FlowServiceError) return { ok: false, status: e.status, code: e.code, message: e.message };
    throw e;
  }
  const settled = waitForRunSettled(accepted.runId, flowQueueTuning.syncWaitMs);
  await pumpOrg(db.orgId);
  await settled;
  const run = await db.flowRun.findUnique({ where: { id: accepted.runId }, select: { status: true, error: true } });
  const status = run?.status ?? 'QUEUED';
  const failed = isFlowRunFinal(status) && status !== 'SUCCEEDED';
  if (failed) log.warn(`結果ページからの実行が失敗 org=${db.orgId} run=${accepted.runId} status=${status}`);
  const errMessage = (run?.error as { message?: unknown } | null)?.message;
  return {
    ok: true,
    data: {
      ok: !failed,
      message: failed ? (typeof errMessage === 'string' ? errMessage : '実行に失敗しました') : (SUBMIT_MESSAGE[status] ?? '受け付けました'),
      sample: false,
      runId: accepted.runId,
      status,
    },
  };
}
