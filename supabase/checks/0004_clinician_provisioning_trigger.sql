-- VITAL OS — checks for supabase/migrations/0004_clinician_provisioning_trigger.sql
--
-- CHECKS 1-2 are read-only SQL.
-- CHECKS 3-6 are a live reproduction: they create a throwaway auth user, watch
-- the trigger fire, and delete it. Read the whole file before starting.
-- CHECK 7 is a login test and is the most important one here.
--
-- RUN ONE AT A TIME. The SQL Editor renders only the LAST statement's result.

-- ---------------------------------------------------------------------------
-- CHECK 1 — the function exists and is hardened
-- Expect one row:
--   handle_clinician_provisioning | security_definer true | search_path=""
-- security_definer false means the trigger cannot write to public.clinicians
-- when fired by supabase_auth_admin, and every provision will log a warning.
-- ---------------------------------------------------------------------------
select p.proname,
       p.prosecdef as security_definer,
       p.proconfig as settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'handle_clinician_provisioning';


-- ---------------------------------------------------------------------------
-- CHECK 2 — both triggers are attached to auth.users
-- Expect two rows:
--   on_auth_user_created            INSERT  (no condition)
--   on_auth_user_metadata_changed   UPDATE  WHEN (old.raw_user_meta_data IS
--                                                 DISTINCT FROM new...)
-- A missing WHEN on the update trigger means it fires on every sign-in.
-- ---------------------------------------------------------------------------
select t.tgname,
       case t.tgtype::int & 28
         when 4 then 'INSERT' when 16 then 'UPDATE' else 'OTHER' end as event,
       pg_get_triggerdef(t.oid) as definition
from pg_trigger t
where t.tgrelid = 'auth.users'::regclass
  and not t.tgisinternal
order by t.tgname;


-- ---------------------------------------------------------------------------
-- CHECK 3 — LIVE: insert with no metadata provisions as 'staff'
--
-- Dashboard → Authentication → Users → Add user.
--   Email:    trigger-probe@example.com
--   Password: anything
--   Leave "Auto Confirm User" as you like; metadata stays empty.
--
-- Then run this. Expect ONE row: role 'staff', full_name null, staff_ref null,
-- hospital_id 'vital-demo-hospital'.
--
-- Zero rows means the trigger did not fire or the insert was swallowed --
-- check Supabase → Logs → Postgres for a "VITAL-OS: clinician provisioning
-- failed" warning before doing anything else.
-- ---------------------------------------------------------------------------
select c.role, c.full_name, c.staff_ref, c.hospital_id
from public.clinicians c
join auth.users u on u.id = c.id
where u.email = 'trigger-probe@example.com';


-- ---------------------------------------------------------------------------
-- CHECK 4 — LIVE: metadata change syncs through
-- This is the case an INSERT-only trigger would miss, and it is exactly how
-- the first three accounts were provisioned.
-- Expect: UPDATE 1.
-- ---------------------------------------------------------------------------
update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
    || '{"full_name":"Trigger Probe","role":"doctor","doctor_id":"19999"}'::jsonb
where email = 'trigger-probe@example.com';


-- ---------------------------------------------------------------------------
-- CHECK 5 — LIVE: confirm the sync landed
-- Expect: role 'doctor', full_name 'Trigger Probe', staff_ref '19999'.
-- Still 'staff' means the UPDATE trigger's WHEN clause did not match.
-- ---------------------------------------------------------------------------
select c.role, c.full_name, c.staff_ref, c.hospital_id
from public.clinicians c
join auth.users u on u.id = c.id
where u.email = 'trigger-probe@example.com';


-- ---------------------------------------------------------------------------
-- CHECK 6 — LIVE: clean up, and verify the cascade
--
-- Delete trigger-probe@example.com from Authentication → Users, then run this.
-- Expect: auth_users 3, clinician_rows 3, matches true.
--
-- clinician_rows 4 means ON DELETE CASCADE is not working and an orphaned row
-- carrying a live role survived the user's deletion.
-- ---------------------------------------------------------------------------
select
  (select count(*) from auth.users)        as auth_users,
  (select count(*) from public.clinicians) as clinician_rows,
  (select count(*) from auth.users)
    = (select count(*) from public.clinicians) as matches;


-- ---------------------------------------------------------------------------
-- CHECK 7 — LOGIN STILL WORKS  ← the one that matters most
--
-- Not SQL. A trigger on auth.users that raises turns every sign-in into an
-- opaque 500 with nothing pointing at this function, and no query in this file
-- would catch it.
--
--   npm run dev
--   Sign in as one of the three real accounts.
--
-- Expect a normal sign-in landing on the roster. If it fails, run
-- 0004_rollback.sql (below) first, confirm login recovers, and report the
-- Postgres log before changing anything.
--
-- Rollback, if needed:
--   drop trigger if exists on_auth_user_metadata_changed on auth.users;
--   drop trigger if exists on_auth_user_created on auth.users;
--   drop function if exists public.handle_clinician_provisioning();
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- CHECK 8 — the three real accounts are untouched
-- Expect the same 3 rows as the 0003 checks:
--   doctor Ada Lovelace 10001 / doctor Eknoor Sidhu 10002 / staff Sam Rivera 20001
-- ---------------------------------------------------------------------------
select role, full_name, staff_ref, hospital_id
from public.clinicians
order by role, staff_ref;
