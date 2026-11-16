-- ⚠️ 草案（Phase 2 用）。**migrations には入れていない。本番で流さないこと。**
-- docs/design/multi-tenancy.md ADR-4
--
-- 前提（これが揃うまでポリシーは効かない）:
--   1. 接続ロールを分ける
--        flow_app    … NOBYPASSRLS。gateway のテナント経路と ai-engine が使う
--        flow_system … BYPASSRLS。スケジューラの claim・webhook の逆引き・回収・migrate が使う
--      今の接続ユーザー（postgres.<ref>）はテーブル所有者で、Supabase では BYPASSRLS を持つ可能性が高い。
--      確認: SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('postgres', current_user);
--   2. アプリが**トランザクションの中で** set_config('app.org_id', <orgId>, true) を呼ぶ
--      （gateway は tenancy/tenant-db.ts の Proxy の中で、本体と同じ batch transaction にする。
--       ⚠️ SET（セッションスコープ）は使わない。プールの接続に値が残り、次の別テナントの要求に漏れる）
--   3. 最初は raw SQL と ai-engine が触る表（AILog / RiskEvent / FileChunk / MessageEmbedding）だけに入れ、
--      往復の増加（BEGIN / set_config / 本体 / COMMIT）を計測してから広げる

-- ── 1. ロール（パスワードは Supabase のダッシュボードで設定する） ──
-- CREATE ROLE flow_app LOGIN NOBYPASSRLS PASSWORD '...';
-- CREATE ROLE flow_system LOGIN BYPASSRLS PASSWORD '...';
-- GRANT USAGE ON SCHEMA public TO flow_app, flow_system;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flow_app, flow_system;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flow_app, flow_system;

-- ── 2. 現在の組織（未設定なら NULL = 何も見えない＝fail-closed） ──
CREATE OR REPLACE FUNCTION app_current_org() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '') $$;

-- ── 3. Phase 2a: アプリ層の強制が効かない表から ──
-- RLS 自体は既に全表で ENABLE 済み（docs/supabase-migration.md §6）。ポリシーを足すだけ。
CREATE POLICY tenant_isolation ON "AILog"
  FOR ALL TO flow_app
  USING ("orgId" = app_current_org())
  WITH CHECK ("orgId" = app_current_org());

CREATE POLICY tenant_isolation ON "RiskEvent"
  FOR ALL TO flow_app
  USING ("orgId" = app_current_org())
  WITH CHECK ("orgId" = app_current_org());

CREATE POLICY tenant_isolation ON "FileChunk"
  FOR ALL TO flow_app
  USING ("orgId" = app_current_org())
  WITH CHECK ("orgId" = app_current_org());

CREATE POLICY tenant_isolation ON "MessageEmbedding"
  FOR ALL TO flow_app
  USING ("orgId" = app_current_org())
  WITH CHECK ("orgId" = app_current_org());

-- ── 4. Phase 2b: 残りのテナントモデル（apps/api-gateway/src/tenancy/tenant-models.ts の TENANT_MODELS と同じ表） ──
-- 子モデル（Message / TaskLog / RequiredCredential）は orgId を持たないので、親を EXISTS で見るか、
-- orgId 列を足してから（設計書 Q7）。
-- DO $$
-- DECLARE t text;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY['ChatSession','Task','UploadedFile','ScheduledTask','Agent','Project','Vendor',
--     'CostEntry','Deal','ProviderConnection','ChannelConnection','InboundMessage','Invitation','Membership',
--     'Capability','CapabilityGap','ExecutionLog']
--   LOOP
--     EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO flow_app
--       USING ("orgId" = app_current_org()) WITH CHECK ("orgId" = app_current_org())', t);
--   END LOOP;
-- END $$;
--
-- ⚠️ Membership は「所属の確認」（テナントが決まる前）でも読むので、そこは flow_system で読むか、
--    userId でも読めるポリシー（USING ("orgId" = app_current_org() OR "userId" = current_setting('app.user_id', true))）にする。
-- ⚠️ Organization は id = app_current_org() で絞る。User / BillingEvent はポリシーを付けない（flow_system 経由）。

-- ── ロールバック ──
-- DROP POLICY IF EXISTS tenant_isolation ON "AILog";  （各表）
-- DROP FUNCTION IF EXISTS app_current_org();
