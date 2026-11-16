// Capability シードスクリプト
// 使い方:
//   DATABASE_URL=... ORG_ID=<org cuid> npx tsx packages/db-schema/prisma/seed-capabilities.ts
// ORG_ID 未指定なら最古の Organization に対して投入する。

import { PrismaClient, CredentialStatus } from '@prisma/client';
// ノードの一覧は gateway が持つ（組織の作成時にも同じものを入れるため。設計書 E8）
import { DEFAULT_CAPABILITIES as SEED } from '../../../apps/api-gateway/src/services/default-capabilities';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const orgId = process.env.ORG_ID ?? (await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } }))?.id;
  if (!orgId) {
    console.error('ERROR: Organization が 1 件もありません。先にユーザー登録で組織を作ってください。');
    process.exit(1);
  }
  console.log(`シード対象 orgId: ${orgId}`);

  for (const cap of SEED) {
    const existing = await prisma.capability.findUnique({
      where: { orgId_name: { orgId, name: cap.name } },
    });
    const data = {
      orgId,
      name: cap.name,
      displayName: cap.displayName,
      description: cap.description,
      department: cap.department,
      inputSchema: cap.inputSchema as object,
      status: cap.status,
      webhookPath: cap.webhookPath,
    };
    let capId: string;
    if (existing) {
      const updated = await prisma.capability.update({ where: { id: existing.id }, data });
      capId = updated.id;
      console.log(`  [update] ${cap.name}`);
    } else {
      const created = await prisma.capability.create({ data });
      capId = created.id;
      console.log(`  [create] ${cap.name}`);
    }
    for (const provider of cap.providers) {
      const existingCred = await prisma.requiredCredential.findFirst({
        where: { capabilityId: capId, provider },
      });
      if (!existingCred) {
        await prisma.requiredCredential.create({
          data: { capabilityId: capId, provider, status: 'DISCONNECTED' as CredentialStatus },
        });
        console.log(`     + cred ${provider}`);
      }
    }
  }
  console.log('シード完了。');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
