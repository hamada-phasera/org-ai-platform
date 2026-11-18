// 業務ページの登録（upsert）と削除。n8n（登録トークン）と管理者の手動 upsert の両方がここを通る
// （docs/design/custom-pages.md §5.3）。
//
// ■ 冪等
//   定義を正規化（キーを並べ替えた JSON）して sha256 を取り、同じ内容・同じ項目なら何も書かずに { changed: false }。
//   定義が変わったときだけ version を +1。
// ■ 管理者が画面で変えた値を守る（§5.3・K51）
//   status / sortOrder / minRole / icon は **body に書かれたときだけ**上書き（ワークフローの再実行で黙って戻さない）。
//   title / icon は管理者が設定画面（PATCH）で変えると adminEditedFields に記録され、以降 n8n からは上書きしない
//   （title は必須で毎回届くので、書かれたときだけ、では守れない）。管理者の手動 upsert（MANUAL）はそのまま書く。
// ■ 作成元
//   n8n からは source = N8N の行しか更新・削除できない（MANUAL / SEED の行は 409 PAGE_SOURCE_CONFLICT。人が作ったページを上書きしない）。
// ■ 上限
//   新規作成だけ canAddPage で断る（403 PAGE_LIMIT_REACHED）。既存の更新は上限を超えていても通す（降格しても消さない）。
//
// ⚠️ 入力（PageUpsertInput）は呼び出し側で pageUpsertSchema を通してから渡すこと。sampleData はここでは書かない（seed だけ。T16）。

import { createHash } from 'crypto';
import {
  DEFAULT_PAGE_ICON,
  PAGE_SCHEMA_VERSION,
  canAddPage,
  isReservedPageSlug,
  type PageDefinition,
  type PageSource,
  type PageUpsertInput,
} from '@org-ai/shared-types';
import { Prisma } from '@prisma/client';
import type { TenantDb } from '../../tenancy/tenant-db';
import { recordAudit } from '../audit';

/** 登録・手動 upsert の本文の上限（ルートの bodyLimit。定義の 32KB はスキーマが別に見る。K31） */
export const PAGE_REGISTER_BODY_LIMIT = 64 * 1024;

/** ルートが sendError にそのまま渡せる失敗 */
export class PageServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PageServiceError';
  }
}

/** キーを並べ替えた JSON（配列の順は意味があるので保つ） */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** キーの順に依らない JSON の sha256（業務フローの定義のハッシュも同じものを使う） */
export function canonicalHashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function definitionHashOf(definition: PageDefinition): string {
  return canonicalHashOf(definition);
}

export interface UpsertPageArgs {
  slug: string;
  input: PageUpsertInput;
  source: Extract<PageSource, 'N8N' | 'MANUAL'>;
  plan: string;
  /** 操作した人。n8n 経由は null */
  actorId: string | null;
  /** n8n 経由のときの登録トークンの id（値ではない。監査の meta.registrarId。設計書 K26） */
  registrarId?: string;
}

export interface UpsertPageResult {
  slug: string;
  version: number;
  status: string;
  changed: boolean;
  created: boolean;
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2002';
}

const PAGE_SELECT = {
  id: true,
  slug: true,
  title: true,
  icon: true,
  sortOrder: true,
  status: true,
  minRole: true,
  source: true,
  version: true,
  definitionHash: true,
  adminEditedFields: true,
} as const;

/** 管理者が設定画面で変えたら n8n から上書きしない項目（routes/pages.ts の PATCH が記録する） */
export const ADMIN_EDITABLE_FIELDS = ['title', 'icon'] as const;
export type AdminEditableField = (typeof ADMIN_EDITABLE_FIELDS)[number];

export async function upsertPage(db: TenantDb, args: UpsertPageArgs, retried = false): Promise<UpsertPageResult> {
  const { slug, input, source, plan, actorId, registrarId } = args;
  if (isReservedPageSlug(slug)) {
    throw new PageServiceError(400, 'VALIDATION_ERROR', `slug「${slug}」は使えません`);
  }
  const hash = definitionHashOf(input.definition);
  const definition = input.definition as unknown as Prisma.InputJsonValue;
  const auditMeta = (version: number, status: string) => ({
    slug,
    version,
    status,
    source,
    ...(registrarId ? { registrarId } : {}),
  });

  const existing = await db.customPage.findUnique({
    where: { orgId_slug: { orgId: db.orgId, slug } },
    select: PAGE_SELECT,
  });

  if (!existing) {
    // 同じ slug は数えない。findUnique の後に同じ slug が同時に作られても上限で断らず、create の P2002 → 更新へ回す
    const count = await db.customPage.count({ where: { slug: { not: slug } } });
    if (!canAddPage(plan, count)) {
      throw new PageServiceError(
        403,
        'PAGE_LIMIT_REACHED',
        'ご契約のプランで作れるページ数の上限に達しています。プランを上げるか、使っていないページを削除してください。',
      );
    }
    try {
      const created = await db.customPage.create({
        data: {
          orgId: db.orgId,
          slug,
          title: input.title,
          icon: input.icon ?? DEFAULT_PAGE_ICON,
          sortOrder: input.sortOrder ?? 0,
          status: input.status ?? 'DRAFT',
          minRole: input.minRole ?? 'MEMBER',
          source,
          version: 1,
          schemaVersion: PAGE_SCHEMA_VERSION,
          definition,
          definitionHash: hash,
          adminEditedFields: [],
          createdBy: actorId,
          updatedBy: actorId,
        },
        select: PAGE_SELECT,
      });
      await recordAudit(db, {
        action: 'page.upsert',
        actorId,
        targetType: 'custom_page',
        targetId: created.id,
        meta: auditMeta(created.version, created.status),
      });
      return { slug, version: created.version, status: created.status, changed: true, created: true };
    } catch (e) {
      // 同じ slug の同時登録（ワークフローの二重実行）。先に入った行に対する更新としてやり直す（1 回だけ）
      if (isUniqueViolation(e) && !retried) return upsertPage(db, args, true);
      throw e;
    }
  }

  if (source === 'N8N' && existing.source !== 'N8N') {
    throw new PageServiceError(
      409,
      'PAGE_SOURCE_CONFLICT',
      'このページは画面または初期データで作られたため、ワークフローからは更新できません。別の slug を使ってください。',
    );
  }

  const definitionChanged = existing.definitionHash !== hash;
  // n8n からの更新では、管理者が画面で変えた項目は今の値を保つ（MANUAL は管理者自身の操作なので書く）
  const keep = (field: AdminEditableField): boolean => source === 'N8N' && existing.adminEditedFields.includes(field);
  const next = {
    title: keep('title') ? existing.title : input.title,
    icon: keep('icon') ? existing.icon : (input.icon ?? existing.icon),
    sortOrder: input.sortOrder ?? existing.sortOrder,
    status: input.status ?? existing.status,
    minRole: input.minRole ?? existing.minRole,
    // 人が手で上書きしたページは、以降 n8n から上書きされない（MANUAL）。n8n の再登録は N8N のまま
    source: source === 'MANUAL' ? 'MANUAL' : existing.source,
  };
  const fieldsChanged = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== existing[k]);
  if (!definitionChanged && fieldsChanged.length === 0) {
    return { slug, version: existing.version, status: existing.status, changed: false, created: false };
  }

  const version = definitionChanged ? existing.version + 1 : existing.version;
  /* 版を条件に入れて書く（同時に 2 つの更新が来たとき、後の方が古い版を前提に上書きしない） */
  const res = await db.customPage.updateMany({
    where: { id: existing.id, version: existing.version },
    data: {
      ...next,
      version,
      ...(definitionChanged ? { definition, definitionHash: hash, schemaVersion: PAGE_SCHEMA_VERSION } : {}),
      // seed のページを人が上書きしたら、サンプルの応答は捨てる（新しい定義に古いサンプルを当てない。K13・レビュー L8）
      ...(existing.source === 'SEED' && next.source !== 'SEED' ? { sampleData: Prisma.DbNull } : {}),
      updatedBy: actorId,
    },
  });
  if (res.count === 0) {
    if (!retried) return upsertPage(db, args, true);
    throw new PageServiceError(409, 'CONFLICT', '同時に更新されました。もう一度お試しください。');
  }

  await recordAudit(db, {
    action: 'page.upsert',
    actorId,
    targetType: 'custom_page',
    targetId: existing.id,
    meta: { ...auditMeta(version, next.status), changed: [...(definitionChanged ? ['definition'] : []), ...fieldsChanged] },
  });
  if (next.status !== existing.status) {
    await recordAudit(db, {
      action: next.status === 'PUBLISHED' ? 'page.publish' : 'page.unpublish',
      actorId,
      targetType: 'custom_page',
      targetId: existing.id,
      meta: auditMeta(version, next.status),
    });
  }
  return { slug, version, status: next.status, changed: true, created: false };
}

export interface DeletePageArgs {
  slug: string;
  source: Extract<PageSource, 'N8N' | 'MANUAL'>;
  actorId: string | null;
  registrarId?: string;
}

/** 削除。無ければ { deleted: false }（冪等）。n8n からは N8N の行だけ消せる */
export async function deletePage(db: TenantDb, args: DeletePageArgs): Promise<{ deleted: boolean }> {
  const page = await db.customPage.findUnique({
    where: { orgId_slug: { orgId: db.orgId, slug: args.slug } },
    select: { id: true, source: true, version: true },
  });
  if (!page) return { deleted: false };
  if (args.source === 'N8N' && page.source !== 'N8N') {
    throw new PageServiceError(
      409,
      'PAGE_SOURCE_CONFLICT',
      'このページは画面または初期データで作られたため、ワークフローからは削除できません。',
    );
  }
  const res = await db.customPage.deleteMany({ where: { id: page.id } });
  if (res.count === 0) return { deleted: false };
  await recordAudit(db, {
    action: 'page.delete',
    actorId: args.actorId,
    targetType: 'custom_page',
    targetId: page.id,
    meta: { slug: args.slug, version: page.version, source: args.source, ...(args.registrarId ? { registrarId: args.registrarId } : {}) },
  });
  return { deleted: true };
}

/** 値を本文に含めうる zod のエラー（enum の「received 'xxx'」など）。文言を差し替える */
const VALUE_ECHOING_CODES = new Set(['invalid_enum_value', 'invalid_literal']);

/** 登録 API の zod エラーを「場所: 理由」で最初の 3 件（値そのものは載せない。構築者が n8n の実行結果で直せるように） */
export function describeIssues(issues: readonly { code?: string; path: (string | number)[]; message: string }[]): string {
  const parts = issues.slice(0, 3).map((i) => {
    const where = i.path.length ? i.path.join('.') : '(全体)';
    const why = i.code && VALUE_ECHOING_CODES.has(i.code) ? '許可されていない値です' : i.message;
    return `${where}: ${why}`;
  });
  const more = issues.length > 3 ? ` ほか ${issues.length - 3} 件` : '';
  return `${parts.join(' / ')}${more}`;
}
