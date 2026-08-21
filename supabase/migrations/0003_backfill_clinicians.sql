-- VITAL OS — Milestone 2, step 3: backfill clinicians from auth.users
--
-- Populates public.clinicians for every auth.users row that predates the
-- step-4 provisioning trigger. After step 4 ships, new users are provisioned
-- automatically and this file is history -- but it stays in the repo, because
-- re-running it is how a future environment gets seeded.
--
-- Depends on 0002_clinicians.sql.
-- Idempotent: ON CONFLICT DO NOTHING. Re-running inserts nothing and reports
-- success. It does NOT repair a row whose metadata changed after the first run
-- -- that is deliberate, since clinicians becomes the source of truth in step 6
-- and a backfill should not quietly overwrite it.

insert into public.clinicians (id, role, full_name, staff_ref)
select
  u.id,

  -- SAME POLICY AS THE STEP-4 TRIGGER. Metadata carrying no role, or a role
  -- outside the check constraint, lands on 'staff' -- the restricted role,
  -- blocked from every clinical field by isRestrictedClinicalPatch in
  -- lib/auth.ts.
  --
  -- Skipping such rows instead would break the one-row-per-user invariant and
  -- force step 6 to distinguish "no clinician row" from "clinician with no
  -- role". Defaulting keeps the row visible and correctable.
  --
  -- Safe only because signups are disabled on this instance (verified: POST
  -- /auth/v1/signup returns 422 signup_disabled). With open signup, a
  -- self-registered user would land here as staff and could read the roster
  -- through the API once step 6 sources role from this table.
  case
    when u.raw_user_meta_data->>'role' in ('doctor', 'staff')
      then u.raw_user_meta_data->>'role'
    else 'staff'
  end,

  u.raw_user_meta_data->>'full_name',

  -- doctor_id and staff_id collapse into one column. Verified mutually
  -- exclusive across all three live users; coalesce picks whichever is present
  -- and yields null when neither is, which staff_ref permits.
  coalesce(
    u.raw_user_meta_data->>'doctor_id',
    u.raw_user_meta_data->>'staff_id'
  )

from auth.users u

-- hospital_id is omitted on purpose: it takes the column default set in
-- 0002_clinicians.sql. Restating 'vital-demo-hospital' here would put the
-- literal in a third place alongside 0001 and lib/auth.ts.

on conflict (id) do nothing;
