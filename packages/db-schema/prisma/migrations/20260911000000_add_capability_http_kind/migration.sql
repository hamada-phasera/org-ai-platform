-- カスタム HTTP ノード: ユーザーがチャットから定義する任意の外部API呼び出しを
-- Capability 行として表現できるようにする。
--
-- カラム追加とインデックス追加のみで、既存行は kind='n8n' の DEFAULT に落ちるため
-- 本番の prisma migrate deploy で安全（UPDATE を一切含めない）。
-- 既存の native capability（notify_slack / create_google_* ）を kind='native' に
-- backfill しないのは、実行分岐が kind='http' → adapter → n8n の順で決まり、
-- native は adapter レジストリが真実の源だから（backfill しても挙動は変わらない）。
--
-- ⚠️ httpConfig.headers[].value は secret=true のとき secret-box.ts の AES-256-GCM
--    暗号文（'v1:iv:tag:cipher'）のみを格納する。平文の API キーを入れてはならない。
-- ⚠️ このカラムを含む行を API レスポンスへ生で流さないこと（sanitizeCapability 必須）。

ALTER TABLE "Capability" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'n8n';
ALTER TABLE "Capability" ADD COLUMN "httpConfig" JSONB;
ALTER TABLE "Capability" ADD COLUMN "createdBy" TEXT;

CREATE INDEX "Capability_orgId_kind_idx" ON "Capability"("orgId", "kind");
