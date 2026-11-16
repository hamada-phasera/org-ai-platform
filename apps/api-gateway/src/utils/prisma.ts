import { PrismaClient } from '@prisma/client';
import { config } from '../config/env';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

const databaseUrl = config.databaseUrl;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Provide a PostgreSQL connection string (Neon) for production, or set one in .env for local dev.',
  );
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: config.isProduction ? ['error'] : ['query', 'error', 'warn'],
  });

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}
