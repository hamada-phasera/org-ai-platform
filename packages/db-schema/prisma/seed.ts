import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { SAMPLE_PAGE_SLUG, seedSamplePages } from './seed-pages';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash('demo1234', 10);

  const org = await prisma.organization.upsert({
    where: { id: 'demo-org-001' },
    update: {},
    create: {
      id: 'demo-org-001',
      name: 'Demo Corp',
      plan: 'STARTER',
    },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@demo.com' },
    update: {},
    create: {
      email: 'admin@demo.com',
      passwordHash,
      name: 'Admin User',
      role: 'OWNER',
      orgId: org.id,
    },
  });
  // 所属の正本は Membership（User.role / User.orgId は移行期間中の写し）
  await prisma.membership.upsert({
    where: { userId_orgId: { userId: admin.id, orgId: org.id } },
    update: {},
    create: { userId: admin.id, orgId: org.id, role: 'OWNER' },
  });

  // 業務ページのサンプル（docs/design/custom-pages.md §8）。PAGES_SAMPLE_MODE=true なら n8n 無しで /p/inquiries が動く
  const page = await seedSamplePages(prisma, org.id);

  console.log('Seed data created successfully');
  console.log('  Organization: Demo Corp (id: demo-org-001)');
  console.log('  User: admin@demo.com / demo1234');
  console.log(`  Page: /p/${SAMPLE_PAGE_SLUG} (${page})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
