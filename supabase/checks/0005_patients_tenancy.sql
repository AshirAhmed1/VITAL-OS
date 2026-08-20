-- VITAL OS — checks for supabase/migrations/0005_patients_tenancy.sql
--
-- CHECKS 1-6 are read-only SQL. CHECK 7 is a live app test and is the one that
-- matters most: this is the first migration that can break the roster.
--
-- RUN ONE AT A TIME. The SQL Editor renders only the LAST statement's result.

-- ---------------------------------------------------------------------------
-- CHECK 1 — columns exist with the right shape
-- Expect exactly 2 rows:
--   clinician_id  uuid  YES  (null)
--   hospital_id   text  NO   'vital-demo-hospital'::text
--
-- hospital_id nullable, or without that default, means the seed path will fail
-- on the next roster fetch.
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'patients'
  and column_name in ('hospital_id', 'clinician_id')
order by column_name;


-- ---------------------------------------------------------------------------
-- CHECK 2 — every existing patient was backfilled
-- Expect: total = with_hospital, no_hospital 0, distinct_hospitals 1.
--
-- ADD COLUMN with a NOT NULL default backfills in place, so this should hold
-- without a separate backfill migration.
-- ---------------------------------------------------------------------------
select count(*)                                        as total,
       count(hospital_id)                              as with_hospital,
       count(*) - count(hospital_id)                   as no_hospital,
       count(distinct hospital_id)                     as distinct_hospitals,
       count(clinician_id)                             as with_clinician
from public.patients;
-- with_clinician is expected to be 0. Step 6 populates it.


-- ---------------------------------------------------------------------------
-- CHECK 3 — foreign keys, and their delete behaviour
-- Expect two FK rows among the output:
--   hospital_id  -> public.hospitals(id)    (no ON DELETE clause = NO ACTION)
--   clinician_id -> public.clinicians(id)   ON DELETE SET NULL
--
-- ON DELETE CASCADE on clinician_id would mean deleting a clinician deletes
-- their patients. ON DELETE RESTRICT would block auth user deletion entirely,
-- because clinicians already cascades from auth.users.
-- ---------------------------------------------------------------------------
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.patients'::regclass
  and contype = 'f'
order by conname;


-- ---------------------------------------------------------------------------
-- CHECK 4 — indexes
-- Expect patients_hospital_id_idx and patients_clinician_id_idx present.
-- ---------------------------------------------------------------------------
select indexname
from pg_indexes
where schemaname = 'public'
  and tablename = 'patients'
  and indexname in ('patients_hospital_id_idx', 'patients_clinician_id_idx')
order by indexname;


-- ---------------------------------------------------------------------------
-- CHECK 5 — column privileges (informational, not a gate)
-- Expect 4 rows: anon and authenticated, each with UPDATE on both columns.
--
-- This is inherited from the table-level UPDATE grant in supabase/patients.sql
-- and is EXPECTED. An earlier draft of 0005 tried to revoke it at the column
-- level; that statement succeeds and does nothing, because a column-level
-- REVOKE cannot remove a table-level grant -- table UPDATE implies UPDATE on
-- every column, including ones added later.
--
-- M3 pins hospital_id with an RLS WITH CHECK instead, which needs no column
-- enumeration and covers future columns automatically.
-- ---------------------------------------------------------------------------
select grantee, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'patients'
  and column_name in ('hospital_id', 'clinician_id')
  and grantee in ('anon', 'authenticated')
  and privilege_type = 'UPDATE'
order by grantee, column_name;


-- ---------------------------------------------------------------------------
-- CHECK 6 — table-level writes still work for the app
-- Expect INSERT, DELETE, SELECT and UPDATE for both anon and authenticated.
--
-- The column revoke must not have removed table-level UPDATE. If UPDATE is
-- missing entirely, every chart edit will fail.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'patients'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;


-- ---------------------------------------------------------------------------
-- CHECK 7 — LIVE APP TEST  ← run this, do not skip it
--
-- seedDemoPatientsIfEmpty() runs on every roster fetch and inserts rows that
-- never mention hospital_id. If the default is wrong, the roster breaks. No
-- query above catches that.
--
--   npm run dev
--   1. Sign in and load the roster.            Expect: patients render.
--   2. Edit a chart field (allergy or med).    Expect: saves, survives reload.
--      -> exercises table-level UPDATE past the column revoke.
--   3. Admit a new patient by voice or form.   Expect: succeeds.
--
-- Then confirm the new patient got the tenant by default:
--
--   select id, name, hospital_id, clinician_id
--   from public.patients
--   order by created_at desc nulls last
--   limit 3;
--
-- Expect hospital_id 'vital-demo-hospital', clinician_id null (step 6 fills it).
--
-- Rollback if the roster breaks:
--   alter table public.patients drop column if exists clinician_id;
--   alter table public.patients drop column if exists hospital_id;
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- CHECK 8 — RLS still off on all four tables
-- Expect false for clinicians, hospitals, patients.
-- ---------------------------------------------------------------------------
select relname, relrowsecurity as rls_enabled
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('clinicians', 'hospitals', 'patients')
order by relname;
