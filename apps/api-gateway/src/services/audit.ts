// 管理操作の監査記録（AuditEvent）。書くのはここだけ。
//
// ■ 何を残すか
//   招待・役割変更・無効化・組織の作成と改名・Checkout 開始・プラン変更・追加容量・連携の接続と切断・
//   業務ページの登録／削除／公開と登録トークンの発行／失効・キャンバスの変更・業務フローの作成／変更／削除／有効化／無効化。
//   AILog / RiskEvent は AI の入出力だけなので、「誰が・いつ・何を」を人の操作についてここに残す。
//
// ■ 書き方
//   テナントクライアント（authOf(request).db か tenantDbFrom(tx, orgId)）で書く。orgId は自動で付き、
//   他の組織には書けない。閲覧は GET /api/governance/audit（管理者以上）。
//
// ■ 失敗したとき
//   操作そのものは成功させ、記録の失敗はログに残す（記録の不調で招待や契約が止まると業務が止まる）。
//   組織の作成のように同じトランザクションで書ける場所は、トランザクションの中で書く。
//
// ⚠️ meta に秘密の値を入れない。名前が秘密らしいキー（token / secret / password / key …）は値を落とし、
//    文字列は長さを切る。呼び出し側も、生トークンやメール本文のようなものを渡さないこと。

import type { TenantTx } from '../tenancy/tenant-db';
import { createLogger, errorMessage } from '../utils/logger';

const log = createLogger('audit');

export const AUDIT_ACTIONS = [
  'org.create',
  'org.update',
  'member.invite',
  'member.invite_revoke',
  'member.join',
  'member.role_change',
  'member.status_change',
  'billing.checkout_start',
  'billing.plan_change',
  'billing.storage_addon',
  'integration.connect',
  'integration.disconnect',
  // 業務ページ（docs/design/custom-pages.md §3.3）。n8n 経由は actorId = null、meta.registrarId に登録トークンの id
  'page.upsert',
  'page.delete',
  'page.publish',
  'page.unpublish',
  'page_token.issue',
  'page_token.revoke',
  // ホームキャンバスと業務フロー（docs/design/canvas-home.md §5.5・§7.5）。meta は { flowId, slug, version } だけ（定義の中身は入れない）
  'canvas.update',
  'flow.create',
  'flow.update',
  'flow.delete',
  'flow.enable',
  'flow.disable',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditInput {
  action: AuditAction;
  /** 操作した人（User.id）。システム経路なら null */
  actorId: string | null;
  targetType?: string;
  targetId?: string | null;
  meta?: Record<string, unknown>;
}

/** 値を落とすキー（部分一致・大文字小文字無視）。 */
const SECRET_KEY = /(token|secret|password|passwd|key|authorization|cookie|credential|hash)/i;
const MAX_STRING = 200;
const MAX_DEPTH = 3;
export const REDACTED = '[REDACTED]';

/**
 * meta から秘密らしい値を落とす。入力は書き換えない。
 * 保存してよいのは「何をどう変えたか」が分かる短い値だけ（役割・プラン・口数・プロバイダ名など）。
 */
export function sanitizeAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value.toISOString();
    if (depth >= MAX_DEPTH) return '[…]';
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => walk(v, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) ? REDACTED : walk(v, depth + 1);
      }
      return out;
    }
    return String(value);
  };
  return walk(meta, 0) as Record<string, unknown>;
}

function toRow(db: Pick<TenantTx, 'orgId'>, input: AuditInput) {
  const meta = sanitizeAuditMeta(input.meta);
  return {
    orgId: db.orgId,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    ...(meta ? { meta: meta as object } : {}),
  };
}

/** トランザクションの中で書く（失敗したらトランザクションごと失敗させる）。 */
export async function recordAuditInTx(db: Pick<TenantTx, 'orgId' | 'auditEvent'>, input: AuditInput): Promise<void> {
  await db.auditEvent.create({ data: toRow(db, input) });
}

/** 操作の後に書く。失敗しても例外にしない（ログだけ）。 */
export async function recordAudit(db: Pick<TenantTx, 'orgId' | 'auditEvent'>, input: AuditInput): Promise<void> {
  try {
    await db.auditEvent.create({ data: toRow(db, input) });
  } catch (e) {
    // ⚠️ meta はログに出さない（落とし漏れがあっても外に出さないため）
    log.error(`監査の記録に失敗しました action=${input.action}`, errorMessage(e));
  }
}
