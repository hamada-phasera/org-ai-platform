-- チャンク 7: 管理操作の監査記録と、メールアドレスの小文字化。
--
-- ■ AuditEvent
--   新しい表を足すだけ。既存行には触らない。
--
-- ■ メールの小文字化（User.email / Invitation.email）
--   登録・ログイン・招待は今後、前後の空白を除き小文字にしてから保存・照合する。
--   既存行も揃えるが、⚠️ 小文字にすると別の行と同じになる行（"A@x.jp" と "a@x.jp" が両方ある）は**触らない**
--   （User.email は一意制約。ここで落ちると migrate deploy が失敗のまま残り、デプロイ全体が止まる）。
--   触らなかった行は小文字のメールではログインできないので、デプロイ前に次の SQL で件数を数え、
--   0 でなければオーナーが行を整理する（docs/security.md「メールの小文字化」）:
--
--     SELECT lower(trim(email)) AS normalized, count(*) FROM "User"
--     GROUP BY lower(trim(email)) HAVING count(*) > 1;
--
-- ■ ロールバック: DROP TABLE "AuditEvent";（小文字化は戻さない。照合は小文字で行うので戻す必要が無い）

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_createdAt_idx" ON "AuditEvent"("orgId", "createdAt");

-- メールの小文字化（衝突する行は触らない）
UPDATE "User" u
SET "email" = lower(trim(u."email"))
WHERE u."email" <> lower(trim(u."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "User" o
    WHERE o."id" <> u."id" AND lower(trim(o."email")) = lower(trim(u."email"))
  );

UPDATE "Invitation"
SET "email" = lower(trim("email"))
WHERE "email" IS NOT NULL AND "email" <> lower(trim("email"));
