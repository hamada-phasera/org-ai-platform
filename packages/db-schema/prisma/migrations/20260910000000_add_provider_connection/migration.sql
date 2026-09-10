-- セルフサーブ連携: 組織単位の外部プロバイダ接続（Slack Bot トークン / Google OAuth）。
-- 新規テーブル 1 つのみ・既存行に一切触れないため、本番の prisma migrate deploy で安全。
-- トークン類は secret-box.ts の AES-256-GCM 暗号文のみ保存する（平文は保存しない）。

CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "externalAccountId" TEXT,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- 1 組織 1 プロバイダ 1 接続（LINE の ChannelConnection とは unique の意味論が違うため別テーブル）
CREATE UNIQUE INDEX "ProviderConnection_orgId_provider_key" ON "ProviderConnection"("orgId", "provider");

CREATE INDEX "ProviderConnection_orgId_idx" ON "ProviderConnection"("orgId");

ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
