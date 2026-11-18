-- 業務ページ: 管理者が設定画面で変えた項目を記録する（docs/design/custom-pages.md §5.3・K51、レビュー M2）
--
-- ■ 中身
--   CustomPage."adminEditedFields"（'title' | 'icon' の配列）。PATCH /api/pages/:slug で変えた項目が入り、
--   n8n の再登録（PUT /api/webhooks/n8n/pages/:slug）はここにある項目を上書きしない。
--   追加のみ・既定は空配列（既存の行は今までどおり n8n の値で更新される）。
--
-- ■ ロールバック（手で流す）
--   ALTER TABLE "CustomPage" DROP COLUMN "adminEditedFields";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261121000100_custom_page_admin_edited_fields';

-- AlterTable
ALTER TABLE "CustomPage" ADD COLUMN "adminEditedFields" TEXT[] DEFAULT ARRAY[]::TEXT[];
