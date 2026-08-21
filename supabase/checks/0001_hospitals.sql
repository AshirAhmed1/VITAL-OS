-- VITAL OS — checks for supabase/migrations/0001_hospitals.sql
--
-- Read-only. Safe to re-run at any time, on any environment.
--
-- RUN THESE ONE AT A TIME. The Supabase SQL Editor renders only the result of
-- the LAST statement in a multi-statement run, so pasting the whole file and
-- hitting Run will silently discard checks 1 through 3.

-- ---------------------------------------------------------------------------
-- CHECK 1 — the table exists
-- Expect: hospitals
-- A null here means the migration did not execute against this database.
-- ---------------------------------------------------------------------------
select to_regclass('public.hospitals') as hospitals_exists;


-- ---------------------------------------------------------------------------
-- CHECK 2 — the demo tenant seeded, exactly once
-- Expect: one row, id = vital-demo-hospital, name = VITAL Demo Hospital
-- The id must match DEMO_HOSPITAL_ID in lib/auth.ts. Step 5 defaults
-- patients.hospital_id to this literal.
-- ---------------------------------------------------------------------------
select id, name, created_at from public.hospitals order by id;


-- ---------------------------------------------------------------------------
-- CHECK 3 — RLS is off on BOTH tables
-- Expect: rls_enabled = false for hospitals and for patients.
-- If patients shows true, stop: every roster read is already returning zero
-- rows and that predates anything in M2.
-- M3 flips both to true together, after the cross-tenant denial test.
-- ---------------------------------------------------------------------------
select relname, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('hospitals', 'patients')
order by relname;


-- ---------------------------------------------------------------------------
-- CHECK 4 — hospitals is read-only to the app roles
-- Expect: exactly two rows -- anon/SELECT and authenticated/SELECT.
--
-- Any INSERT, UPDATE, DELETE or TRUNCATE row for anon or authenticated means
-- the revoke did not take. Supabase's schema-level default privileges grant
-- all on new tables in public, so this check is the one that actually proves
-- intent; the grant statements alone do not.
--
-- postgres and service_role are filtered out on purpose -- both are expected
-- to retain full access.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'hospitals'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;


-- ---------------------------------------------------------------------------
-- CHECK 5 — where the unrequested grants come from
-- Diagnostic, not a pass/fail. Expect a row for schema public, objtype 'r',
-- with an ACL listing anon and authenticated. That is the Supabase default
-- and the reason CHECK 4 needs a revoke behind it.
-- Every future table in this schema inherits the same starting position.
-- ---------------------------------------------------------------------------
select defaclrole::regrole           as grantor,
       defaclnamespace::regnamespace as schema,
       defaclobjtype                 as objtype,
       defaclacl                     as default_privileges
from pg_default_acl;
