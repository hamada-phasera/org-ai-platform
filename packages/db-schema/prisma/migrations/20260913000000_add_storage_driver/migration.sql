-- ファイルの保存先をローカルディスクからオブジェクトストレージへ移すための列。
--
-- ⚠️ Render の web サービスはデプロイのたびにファイルシステムが作り直される。
--    render.yaml に disk の宣言が無いため、ローカルに保存したファイルは
--    UploadedFile の行だけが残り、実体が失われる（2026-09-11 時点で本番の行は 0 件＝実害なし）。
--
-- 既存行は storageDriver='local' のまま残す（削除しない）。理由:
--   * FileChunk の RAG 索引は実体が無くても検索に効く。行ごと消すとその資産を捨てることになる
--   * 画面で「再アップロードしてください」と案内できる
--
-- storageAddonUnits は、込みの容量を超えた組織が 1GB 単位で買い増すためのカウンタ。
-- 金額はここに持たない（Stripe の price 側に持つ）。

ALTER TABLE "Organization" ADD COLUMN "storageAddonUnits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UploadedFile" ADD COLUMN "storageDriver" TEXT NOT NULL DEFAULT 'local';

-- 一覧と使用量の再計算が使う。UploadedFile には索引が1本も無かった
CREATE INDEX IF NOT EXISTS "UploadedFile_orgId_idx" ON "UploadedFile"("orgId");
