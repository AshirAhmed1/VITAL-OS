-- VITAL OS — checks for supabase/migrations/0002_clinicians.sql
--
-- Read-only. Safe to re-run at any time.
--
-- RUN ONE AT A TIME. The Supabase SQL Editor renders only the LAST statement's
-- result, so running the whole file silently discards every check but the last.
-- Highlight a single statement and press Run.

-- ---------------------------------------------------------------------------
-- CHECK 1 — the table exists
-- Expect: clinicians
-- ---------------------------------------------------------------------------
select to_regclass('public.clinicians') as clinicians_exists;


-- ---------------------------------------------------------------------------
-- CHECK 2 — column shape
-- Expect exactly 6 rows:
--   created_at   timestamptz  NO   now()
--   full_name    text         YES  (null)
--   hospital_id  text         NO   'vital-demo-hospital'::text
--   id           uuid         NO   (null)
--   role         text         NO   (null)        <- no default, deliberately
--   staff_ref    text         YES  (null)
-- A default on role means the policy leaked out of the step-4 trigger.
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'clinicians'
order by column_name;


-- ---------------------------------------------------------------------------
-- CHECK 3 — constraints
-- Expect four rows:
--   PRIMARY KEY on (id)
--   FOREIGN KEY id -> auth.users(id)          ON DELETE CASCADE
--   FOREIGN KEY hospital_id -> hospitals(id)  ON DELETE NO ACTION
--   CHECK role in ('doctor','staff')
-- plus a UNIQUE on staff_ref.
--
-- The cascade on the auth.users FK is the one to confirm. Without it, deleting
-- a user from the Authentication dashboard leaves an orphaned clinician row
-- carrying a live role.
-- ---------------------------------------------------------------------------
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.clinicians'::regclass
order by contype, conname;


-- ---------------------------------------------------------------------------
-- CHECK 4 — RLS is off on all three tables
-- Expect: false for clinicians, hospitals and patients.
-- M3 flips all three together, after the cross-tenant denial test.
-- ---------------------------------------------------------------------------
select relname, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('clinicians', 'hospitals', 'patients')
order by relname;


-- ---------------------------------------------------------------------------
-- CHECK 5 — the privilege gate
-- Expect exactly ONE row: authenticated / SELECT.
--
-- Any anon row at all, or any INSERT / UPDATE / DELETE / TRUNCATE for
-- authenticated, means the revoke did not take. An inherited UPDATE here is a
-- privilege escalation path: a logged-in browser could PATCH its own row to
-- role 'doctor' through PostgREST.
--
-- postgres and service_role are filtered out on purpose; both keep full access.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'clinicians'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;


-- ---------------------------------------------------------------------------
-- CHECK 6 — still empty
-- Expect: 0. Step 2 creates the table; step 3 backfills it.
-- Rows here now would mean 0003 ran early.
-- ---------------------------------------------------------------------------
select count(*) as clinician_rows from public.clinicians;
