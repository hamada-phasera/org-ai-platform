-- RLS Phase 2a（opt-in）。docs/design/multi-tenancy.md ADR-4 / §RLS Phase 2a、計画書チャンク 11。
--
-- ⚠️ **migrations には入れない**。`prisma migrate deploy` では流れない。オーナーが手で流す（下の手順）。
-- ⚠️ 何度流しても同じ結果になる（ポリシーは DROP IF EXISTS → CREATE）。
--
-- ■ 何をするか
--   アプリ層の強制（tenantDb）が効かない 4 表 AILog / RiskEvent / FileChunk / MessageEmbedding に、
--   「app.org_id と同じ組織の行だけ」のポリシーを flow_app ロールに付ける。
--     - 書くのは ai-engine（SQLAlchemy の生 SQL）と gateway の raw SQL（pgvector の列）で、どちらも tenantDb を通らない
--     - app.org_id が未設定なら NULL → 0 行（fail-closed）。他組織の orgId での INSERT は WITH CHECK で拒否
--
-- ■ 前提（揃ってから流す。揃わないうちは RLS_MODE=off のまま＝今までどおり）
--   1. ロール（Supabase のダッシュボード / SQL エディタでオーナーが作る。O-5）
--        CREATE ROLE flow_app    LOGIN NOBYPASSRLS PASSWORD '...';   -- gateway・ai-engine の接続
--        CREATE ROLE flow_system LOGIN BYPASSRLS   PASSWORD '...';   -- migrate・usage-metrics-svc・手作業の調査
--      確認: SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('flow_app', 'flow_system');
--      ⚠️ flow_app が rolbypassrls / rolsuper だとポリシーは効かない（この SQL の最後で検査して止める）
--   2. gateway と ai-engine に RLS_MODE=on を入れる。アプリが 4 表を触る直前に、同じトランザクションで
--      set_config('app.org_id', <orgId>, true) を呼ぶ（SET は使わない。プールの接続に値が残り、別の組織に漏れる）
--   3. DATABASE_URL の接続ユーザーを flow_app に替える（migrate は所有者 / flow_system のまま）
--
-- ■ 流し方
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db-schema/rls/phase2a.sql
--   または npx prisma db execute --url "$OWNER_DATABASE_URL" --file packages/db-schema/rls/phase2a.sql
--
-- ■ 戻し方（RLS_MODE=off に戻し、接続ユーザーを所有者に戻してから）
--   DROP POLICY IF EXISTS tenant_isolation ON "AILog";  （4 表それぞれ）
--   DROP POLICY IF EXISTS phase2a_passthrough ON <各表>;
--   DROP FUNCTION IF EXISTS app_current_org();

-- ── 0. 権限（flow_app はテーブル所有者ではない。所有者は migrate の接続ユーザーのまま） ──
GRANT USAGE ON SCHEMA public TO flow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flow_app;
-- 以後 migrate で増える表にも付ける（ALTER DEFAULT PRIVILEGES は「この SQL を流したロール」が作る表に効く）
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flow_app;

-- ── 1. 現在の組織（未設定・空文字なら NULL = 何も見えない＝fail-closed） ──
CREATE OR REPLACE FUNCTION app_current_org() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '') $$;

-- ── 2. Phase 2a の 4 表 ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AILog', 'RiskEvent', 'FileChunk', 'MessageEmbedding']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS phase2a_passthrough ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO flow_app '
      'USING ("orgId" = app_current_org()) WITH CHECK ("orgId" = app_current_org())', t);
  END LOOP;
END $$;

-- ── 3. それ以外の表は flow_app に素通し（Phase 2b まで） ──
-- Supabase では全表で RLS を ENABLE 済み（docs/supabase-migration.md §6。Data API の蓋）。
-- ポリシーが 1 つも無い表は flow_app から 0 行になり、アプリが壊れる。2a ではアプリ層の tenantDb が分離を担うので、
-- RLS が有効な残りの表に flow_app 限定の素通しを付ける（anon 等の他のロールは従来どおり拒否のまま）。
-- ⚠️ これを流した後に migrate で増えた表は素通しが無い。表を足したらこの SQL をもう一度流す。
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname NOT IN ('AILog', 'RiskEvent', 'FileChunk', 'MessageEmbedding')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS phase2a_passthrough ON public.%I', t.name);
    EXECUTE format(
      'CREATE POLICY phase2a_passthrough ON public.%I FOR ALL TO flow_app USING (true) WITH CHECK (true)', t.name);
  END LOOP;
END $$;

-- ── 4. 検査: flow_app がポリシーを素通りできるなら止める（流しても柵にならない） ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_app' AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'flow_app が BYPASSRLS / SUPERUSER です。ALTER ROLE flow_app NOBYPASSRLS NOSUPERUSER; の後に流してください';
  END IF;
END $$;
