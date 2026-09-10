// セルフサーブ接続（ProviderConnection）と capability 側の表示状態
// （RequiredCredential.status / Capability.status）の同期。
// 呼び出し点: Slack 接続/解除、Google OAuth callback 成功/解除、refresh 失敗時。

import type { ProviderConnectionProvider } from '@org-ai/shared-types';
import { prisma } from '../utils/prisma';
import { credentialProvidersFor } from './adapters/provider-map';

/**
 * provider に対応する RequiredCredential 群の status を org 内で一括更新し、
 * 影響を受けた Capability の status（ACTIVE / NEEDS_AUTH）も追随させる。
 * updateMany の where は capability リレーションで orgId を縛り、org 越境更新を防ぐ。
 */
export async function syncRequiredCredentialStatus(
  orgId: string,
  provider: ProviderConnectionProvider,
  status: 'CONNECTED' | 'DISCONNECTED',
): Promise<void> {
  const credProviders = credentialProvidersFor(provider);
  if (credProviders.length === 0) return;

  await prisma.requiredCredential.updateMany({
    where: { provider: { in: credProviders }, capability: { orgId } },
    data: { status, lastCheckedAt: new Date() },
  });

  // 影響 capability の status を再計算（全 creds CONNECTED なら ACTIVE、欠けがあれば NEEDS_AUTH）。
  // DISABLED は運用者の意思なので触らない。
  const caps = await prisma.capability.findMany({
    where: { orgId, status: { not: 'DISABLED' }, requiredCreds: { some: { provider: { in: credProviders } } } },
    include: { requiredCreds: true },
  });
  for (const cap of caps) {
    const allConnected = cap.requiredCreds.every((c) => c.status === 'CONNECTED');
    const next = allConnected ? 'ACTIVE' : 'NEEDS_AUTH';
    if (cap.status !== next) {
      await prisma.capability.update({ where: { id: cap.id }, data: { status: next } });
    }
  }
}
