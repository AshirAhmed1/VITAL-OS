-- VITAL OS — checks for supabase/migrations/0003_backfill_clinicians.sql
--
-- Read-only. Safe to re-run at any time.
--
-- RUN ONE AT A TIME. The SQL Editor renders only the LAST statement's result.
-- Highlight a single statement and press Run.

-- ---------------------------------------------------------------------------
-- CHECK 1 — the invariant: one clinician row per auth user
-- Expect: auth_users 3, clinician_rows 3, matches true.
--
-- This is the gate. matches=false means the backfill dropped someone, and
-- step 6 would deny that user every route with no visible cause.
-- ---------------------------------------------------------------------------
select
  (select count(*) from auth.users)         as auth_users,
  (select count(*) from public.clinicians)  as clinician_rows,
  (select count(*) from auth.users)
    = (select count(*) from public.clinicians) as matches;


-- ---------------------------------------------------------------------------
-- CHECK 2 — no auth user was left behind
-- Expect: 0 rows.
--
-- Complements CHECK 1: equal counts could in principle hide a missing row
-- alongside a spurious one. This names the missing ones directly.
-- (The reverse -- a clinician with no auth user -- cannot happen; the FK
-- with ON DELETE CASCADE prevents it.)
-- ---------------------------------------------------------------------------
select u.id
from auth.users u
left join public.clinicians c on c.id = u.id
where c.id is null;


-- ---------------------------------------------------------------------------
-- CHECK 3 — the data landed correctly
-- Expect 3 rows, no nulls in role or full_name:
--   doctor  Ada Lovelace   10001  vital-demo-hospital
--   doctor  Eknoor Sidhu   10002  vital-demo-hospital
--   staff   Sam Rivera     20001  vital-demo-hospital
--
-- Compare against the auth metadata query from earlier this session. No emails
-- in the output by design.
-- ---------------------------------------------------------------------------
select role, full_name, staff_ref, hospital_id, created_at
from public.clinicians
order by role, staff_ref;


-- ---------------------------------------------------------------------------
-- CHECK 4 — role distribution matches auth metadata exactly
-- Expect 2 rows, both with source_matches true:
--   doctor 2 2 true
--   staff  1 1 true
--
-- A mismatch means the CASE fallback fired -- some user's metadata role was
-- absent or outside the check constraint and silently became 'staff'.
-- ---------------------------------------------------------------------------
select
  c.role,
  count(*) as clinicians_count,
  (select count(*) from auth.users u
    where u.raw_user_meta_data->>'role' = c.role) as metadata_count,
  count(*) = (select count(*) from auth.users u
               where u.raw_user_meta_data->>'role' = c.role) as source_matches
from public.clinicians c
group by c.role
order by c.role;


-- ---------------------------------------------------------------------------
-- CHECK 5 — every row points at a real hospital
-- Expect: 0 rows. The FK guarantees this, so a result here would mean the
-- constraint is missing rather than the data being wrong.
-- ---------------------------------------------------------------------------
select c.id, c.hospital_id
from public.clinicians c
left join public.hospitals h on h.id = c.hospital_id
where h.id is null;


-- ---------------------------------------------------------------------------
-- CHECK 6 — the privilege gate still holds after the insert
-- Expect exactly ONE row: authenticated / SELECT.
-- Re-checked here because clinicians now holds real roles: an inherited UPDATE
-- would be a live escalation path, not a theoretical one.
-- ---------------------------------------------------------------------------
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'clinicians'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;


-- ---------------------------------------------------------------------------
-- CHECK 7 — idempotency
-- Re-run 0003_backfill_clinicians.sql, then run CHECK 1 again.
-- Expect identical counts. A second run must insert nothing.
-- Nothing to execute here; this is a procedure note.
-- ---------------------------------------------------------------------------
