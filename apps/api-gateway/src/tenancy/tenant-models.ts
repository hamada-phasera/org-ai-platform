// テナント分離の対象になるモデルの表（docs/design/multi-tenancy.md §7.1.2 / §11.1 T8）。
//
// ⚠️ schema.prisma に orgId を持つモデルを足したら、必ずここにも足すこと。
//    足し忘れは tenancy/__tests__/tenant-models.test.ts（schema.prisma を読んで突き合わせる）が落とす。

/** `orgId String`（必須）を持つモデル。テナントクライアントが where / data に orgId を自動で付ける。 */
export const TENANT_MODELS = [
  'ChatSession',
  'Task',
  'UploadedFile',
  'ScheduledTask',
  'Agent',
  'Project',
  'Vendor',
  'CostEntry',
  'Deal',
  'ProviderConnection',
  'ChannelConnection',
  'InboundMessage',
  'Invitation',
  'Membership',
  'AILog',
  'RiskEvent',
  'FileChunk',
  'MessageEmbedding',
  'Capability',
  'CapabilityGap',
  'ExecutionLog',
  'AuditEvent',
] as const;

/**
 * orgId を持たず、親を通して所属するモデル。テナントクライアントは**書き換えない**。
 * 不変条件 I2: 同じテナントクライアントで親を取れたときにだけ読み書きしてよい（呼び出し側の規律）。
 */
export const CHILD_MODELS = ['Message', 'TaskLog', 'RequiredCredential'] as const;

/**
 * Organization はテナントそのもの。テナントクライアントでは `id = orgId` の1行だけを見せる
 * （作成・削除はできない）。
 */
export const ORG_ROOT_MODEL = 'Organization' as const;

/**
 * 全体で共有するモデル（orgId が null を許す = テナントの外側）。テナントクライアントには出さない。
 *   User         … 全体で一意の本人。User.orgId は「最後に選んだ組織」
 *   BillingEvent … Stripe webhook の処理済み記録（システム経路だけが書く）
 */
export const GLOBAL_MODELS = ['User', 'BillingEvent'] as const;

export type TenantModel = (typeof TENANT_MODELS)[number];
export type ChildModel = (typeof CHILD_MODELS)[number];

/** Prisma のモデル名 → クライアントのプロパティ名（'AILog' → 'aILog'）。 */
export function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

const TENANT_SET: ReadonlySet<string> = new Set(TENANT_MODELS);
export function isTenantModel(model: string): model is TenantModel {
  return TENANT_SET.has(model);
}
