import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

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

  console.log('Seed data created successfully');
  console.log('  Organization: Demo Corp (id: demo-org-001)');
  console.log('  User: admin@demo.com / demo1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
