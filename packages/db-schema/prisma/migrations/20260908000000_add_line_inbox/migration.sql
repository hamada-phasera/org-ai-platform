-- LINE 受信箱: LINE 公式アカウント接続 (ChannelConnection) と受信メッセージ (InboundMessage) を追加。
-- 新規テーブル 2 つ + インデックス + FK の追加のみ。既存テーブル・既存行には一切触れないため、
-- 本番 prisma migrate deploy で安全に適用可能。
-- - ChannelConnection.channelSecretEnc / accessTokenEnc は AES-256-GCM 暗号文のみ保存（平文は保存しない）。
-- - InboundMessage の (provider, webhookEventId) unique が LINE webhook 再送の dedupe 本体。
-- - InboundMessage.connectionId は接続削除後もメッセージを残すため ON DELETE SET NULL。

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'line',
    "channelId" TEXT NOT NULL,
    "displayName" TEXT,
    "channelSecretEnc" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "monthlyPushCount" INTEGER NOT NULL DEFAULT 0,
    "pushCountMonth" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'line',
    "webhookEventId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "groupId" TEXT,
    "lineUserId" TEXT,
    "senderName" TEXT,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "draft" TEXT,
    "draftModel" TEXT,
    "draftError" TEXT,
    "replyText" TEXT,
    "repliedAt" TIMESTAMP(3),
    "repliedBy" TEXT,
    "rejectedReason" TEXT,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_provider_channelId_key" ON "ChannelConnection"("provider", "channelId");

-- CreateIndex
CREATE INDEX "ChannelConnection_orgId_provider_idx" ON "ChannelConnection"("orgId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_provider_webhookEventId_key" ON "InboundMessage"("provider", "webhookEventId");

-- CreateIndex
CREATE INDEX "InboundMessage_orgId_status_createdAt_idx" ON "InboundMessage"("orgId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "InboundMessage_connectionId_groupId_createdAt_idx" ON "InboundMessage"("connectionId", "groupId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
