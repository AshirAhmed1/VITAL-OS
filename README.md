# VITAL OS

> Speech-first clinical support.
> Browser microphone → LLM → browser speaker.

A voice-controlled clinical assistant for hospital floor work: admit and discharge
patients, pull up charts, draft medication orders, and ask clinical questions —
all by speaking. Built with Next.js 14 (App Router), TypeScript, Supabase, and a
dual-provider LLM path (Groq primary, Google Gemini fallback).

---

## Requirements

| | |
|---|---|
| **Node.js** | 18.17+ (Node 20 LTS recommended — it's what Vercel runs; Node 24 works but is outside Next 14.2's tested matrix) |
| **Browser** | Chrome or Edge. The voice path uses `webkitSpeechRecognition`, which Firefox and Safari do not implement. |
| **Gemini API key** | https://aistudio.google.com/apikey |
| **Groq API key** | Optional but recommended — https://console.groq.com/keys |
| **Supabase project** | Free tier is fine — https://supabase.com |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

<details>
<summary><strong>Windows: "npm.ps1 cannot be loaded because running scripts is disabled"</strong></summary>

PowerShell's execution policy is blocking npm's shim. Fix it once for your user
account (no admin required), then open a **new** terminal:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Or sidestep it entirely — the `.cmd` shim isn't a PowerShell script:

```powershell
npm.cmd install
```
</details>

### 2. Create your environment file

```bash
cp .env.example .env.local          # macOS / Linux
Copy-Item .env.example .env.local   # Windows PowerShell
```

Then fill in the required values:

| Variable | Required | Where to get it |
|---|---|---|
| `GEMINI_API_KEY` | yes | https://aistudio.google.com/apikey |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase → Settings → API → `anon` `public` key |
| `GROQ_API_KEY` | no | https://console.groq.com/keys — see below |
| `GEMINI_CLINICAL_MODEL` | no | Intent parsing and clinical reasoning. Defaults to `gemini-3.5-flash` |
| `GEMINI_MODEL` | no | The `/api/vital` general assistant. Defaults to `gemini-3.5-flash` |
| `GROQ_INTENT_MODEL` | no | Defaults to `openai/gpt-oss-120b` |
| `GROQ_WHISPER_MODEL` | no | Defaults to `whisper-large-v3-turbo` |

**On `GROQ_API_KEY`.** When set, Groq becomes the primary leg for both
transcription and intent parsing, with Gemini as the fallback. Leave it blank to
run Gemini-only — the provider chain skips unconfigured legs, so the app works
either way.

Use the **`anon` / `public`** Supabase key, never the `service_role` key. The
`NEXT_PUBLIC_` prefix ships that value to every browser that loads the app.

Model IDs are environment variables on purpose: both vendors retire models on
roughly six-month cycles, so a deprecation should be a config change rather than
a code change. See [Checking for dead models](#checking-for-dead-models).

Next.js reads `.env.local` only at startup — **fully restart** the dev server
after editing it. Several constants are read at module init, so a hot reload
won't pick them up.

### 3. Set up the database

The patient roster, clinician roles, and hospital tenancy are all persisted in
Supabase Postgres. Without this step the roster and chart views fail, and every
clinical action returns 403 — role is read from the database, so a missing
`clinicians` table denies everything.

In your Supabase dashboard → **SQL Editor** → **New query**, run each file
below as its own query, **in this order**:

| # | File | What it does |
|---|---|---|
| 1 | `supabase/patients.sql` | `patients` table, indexes, `updated_at` trigger, role grants |
| 2 | `supabase/add_patient_voice_fields.sql` | Chart notes and discharge columns |
| 3 | `supabase/migrations/0001_hospitals.sql` | `hospitals` — the tenancy root |
| 4 | `supabase/migrations/0002_clinicians.sql` | `clinicians` — the authoritative role store |
| 5 | `supabase/migrations/0003_backfill_clinicians.sql` | Populates `clinicians` from existing `auth.users` |
| 6 | `supabase/migrations/0004_clinician_provisioning_trigger.sql` | Provisions new users automatically |
| 7 | `supabase/migrations/0005_patients_tenancy.sql` | `hospital_id` and `clinician_id` on `patients` |

**Order matters.** Each migration references tables the previous one creates.

**Step 2 is required, not optional.** Skipping it does not produce an error —
`lib/patient-store.ts` catches the missing column and retries without it, so
every admission silently returns `201` with its chart notes discarded.

**Run step 3 onward again after creating your accounts** in section 5. Migration
5 reads whatever is in `auth.users` at the time; if you set up accounts later,
re-run `0003_backfill_clinicians.sql` to pick them up. It is idempotent.

All files are idempotent (`if not exists` / `on conflict do nothing`), so
re-running any of them is safe. `Success. No rows returned` is the expected
output — DDL doesn't return rows.

Ignore the other two SQL files: `merge_symptoms_into_problems.sql` is marked
deprecated in its own header, and `reset_problems_diagnoses_only.sql` is a data
reset, not a schema step.

#### Verifying

Each migration has a matching read-only file in `supabase/checks/` listing its
expected results. **Run those one statement at a time** — the Supabase SQL Editor
renders only the last statement's output, so running a checks file whole
silently discards everything but the final query.

One query confirms the whole schema:

```sql
select
  (select count(*) from public.hospitals)                          as hospitals,
  (select count(*) from public.clinicians)                         as clinicians,
  (select count(*) from auth.users)                                as auth_users,
  (select count(*) from public.patients where hospital_id is null) as patients_without_tenant,
  (select count(*) from pg_trigger
     where tgrelid = 'auth.users'::regclass and not tgisinternal)  as auth_triggers;
```

`clinicians` must equal `auth_users`, `patients_without_tenant` must be `0`, and
`auth_triggers` must be `2`. A clinician count below the user count means
someone will authenticate successfully and then be denied every action.

> **If Supabase prompts you to "Enable RLS", decline it.** This demo runs with
> Row Level Security disabled — see [Security posture](#security-posture).
> Enabling RLS without policies returns zero rows on every read, with no error.
> Decline the linter's auto-generated `USING (true)` policy too; it grants
> everything while looking like a control.

You do **not** need to seed patient data manually. The first call to
`listPatients()` runs `seedDemoPatientsIfEmpty()` and inserts the demo roster.

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3000** in Chrome or Edge and allow microphone access
when prompted.

### 5. Create your clinician accounts

Authentication is Supabase Auth — email and password, with the clinical role
carried in user metadata. **There are no credentials in this repo.**

In your Supabase dashboard go to **Authentication -> Users -> Add user ->
Create new user** and create your accounts with **Auto Confirm User** ticked.
An unconfirmed account cannot sign in.

Then in **SQL Editor**, attach a role to each account, substituting your own
addresses:

```sql
update auth.users
set raw_user_meta_data =
      coalesce(raw_user_meta_data, '{}'::jsonb)
      || '{"full_name":"Ada Lovelace","role":"doctor","doctor_id":"10001"}'::jsonb
where lower(email) = lower('doctor@example.com');

update auth.users
set raw_user_meta_data =
      coalesce(raw_user_meta_data, '{}'::jsonb)
      || '{"full_name":"Sam Rivera","role":"staff","staff_id":"20001"}'::jsonb
where lower(email) = lower('staff@example.com');
```

`||` merges rather than replaces, so existing metadata is preserved. Emails are
stored lowercased, so compare with `lower()` or the `where` clause silently
matches nothing.

Verify before signing in:

```sql
select email,
       raw_user_meta_data ->> 'full_name' as full_name,
       raw_user_meta_data ->> 'role'      as role,
       email_confirmed_at is not null     as confirmed
from auth.users
order by created_at;
```

Every account needs `confirmed = true` and a role of `doctor` or `staff`. An
account with no role is signed straight back out — the permission model has
nowhere to place it.

Metadata is the **write** source for roles; the `clinicians` table is what the
server actually reads. A trigger installed by
`supabase/migrations/0004_clinician_provisioning_trigger.sql` keeps them in sync
— it fires on user creation and again whenever metadata changes, so the `update`
statements above provision the `clinicians` row for you.

If you created your accounts **before** running the migrations, the trigger did
not exist yet. Re-run `supabase/migrations/0003_backfill_clinicians.sql` to
populate `clinicians` for them, then confirm:

```sql
select role, full_name, staff_ref, hospital_id
from public.clinicians
order by role, staff_ref;
```

One row per account. A user with no row here authenticates normally and is then
denied every clinical action — the server treats a missing row as "deny".

Sign in with a doctor account. `/api/vital` and `/api/clinical-command` reject
anything that isn't `role === "doctor"`.

Doctor and staff IDs are **attributes, not credentials** — they identify a
clinician in the UI and do not authenticate anyone.

## Verify your setup

With the dev server running, in a second terminal:

```bash
curl http://localhost:3000/api/vital      # expect hasApiKey: true, rosterPatients > 0
curl http://localhost:3000/api/patients   # expect a roster array
```

On Windows PowerShell, prefer `Invoke-RestMethod` — it parses JSON responses and
handles request bodies more predictably than `curl.exe`:

```powershell
Invoke-RestMethod http://localhost:3000/api/vital
```

If `/api/vital` reports `rosterPatients: 0` but `/api/patients` returns patients,
that's harmless: the status endpoint swallows errors and reports zero. If
`/api/patients` errors, it surfaces the real Postgres message — read that first.

### Checking for dead models

Both vendors retire models on rolling schedules, and a retired model does **not**
break the app — the provider chain quietly falls through to the other vendor and
keeps answering. A working app is therefore not evidence that the primary path
works. The only evidence is which provider actually answered.

Open the app, run any clinical command, then open **Workspace → System**:

- `INTENT: Groq · <n> ms` in cyan — primary leg healthy
- `INTENT: Gemini fallback - Groq degraded` in amber — the Groq model ID is dead
  or the key is missing
- `STT: Whisper via Groq` in cyan — Whisper is transcribing
- `STT: Browser SR - Whisper degraded` in amber — the transcription leg failed

The workspace toggle also shows an amber dot when the last utterance fell back,
so a degrade is visible without opening anything.

This is a ten-second health check worth running whenever you come back to the
project cold. Two silent deprecations have been caught this way.

---

## Try it yourself

VITAL OS is fully voice-controlled. Click the voice activation (unmute) button,
then speak naturally — the parser handles conversational phrasing, not rigid commands.

**Admit a patient.** Say:

> "Hey Vital, admit patient Maria Lopez."

It walks you through name confirmation (including spelling), age and sex, chief
concern, room, and medications, then reads back a summary for you to confirm.

You can front-load the details in one utterance instead:

> "Hey Vital, admit patient James Carter, sixty-eight year old male, room fourteen,
> chest pain, CTAS two, needs aspirin."

**Other commands:**

- "Hey Vital, discharge Maria Lopez."
- "Hey Vital, what's the status of James Carter?"
- "Hey Vital, show me all patients in triage."
- "Hey Vital, pull up Maria Lopez's medications."
- "Hey Vital, what could be causing her chest pain?"

**Useful phrases:**

- The wake word is optional and forgiving — "Hey Vital", "Okay Vital", or just
  "Vital" all work, and common mishears are tolerated.
- "That's all I know" / "just admit them" skips ahead to the confirmation step.
- Confirm with: yes / yeah / correct / go ahead / proceed.
- Say "no" at the spelling step to spell the patient's name letter by letter.

---

## Architecture

```
Browser mic
  ├─ SpeechRecognition ──── voice activity detection, interim preview,
  │                         barge-in over TTS, silence-triggered submit
  └─ MediaRecorder ──────── /api/transcribe → Whisper (authoritative transcript)

  → /api/clinical-command  → lib/clinical-intent.ts     transcript → structured JSON intent
                           → lib/clinical-reasoning.ts  differential / clinical Q&A
  → /api/vital             → lib/vital-llm.ts           general assistant + roster tool calls
  → /api/patients          → lib/patient-store.ts       Supabase CRUD

Browser speaker (SpeechSynthesis)
```

### The speech path

`SpeechRecognition` and Whisper run together, with different jobs.

SR is the **voice-activity detector**: it produces interim text for the live
preview, allows barge-in over TTS, drives the silence timer that submits a
command, and surfaces microphone permission errors. Whisper is batch — no
interim results, no endpointing — so it cannot replace any of that.

Whisper is the **authoritative transcript**. Both submit paths route through
`finalizeAndSubmit`, which arbitrates between the two via `chooseTranscript`.
The failure policy is *visible degrade, non-blocking*: the command always
submits, and the fallback is always shown in the System panel.

### The provider chain

Intent parsing races Groq against a 2500 ms budget and falls back to Gemini
(8000 ms). Each leg retries up to 3× on transient failures — 429/408/425/5xx and
undici socket errors — with **all retries sharing one deadline**, so the budget
can't silently multiply. A retry is only scheduled if backoff plus 300 ms still
fits. Server `Retry-After` beats the computed backoff.

Worst case is `PRIMARY_TIMEOUT_MS + FALLBACK_TIMEOUT_MS` = 10.5 s, with a 14 s
client-side transcription timeout on top. The UI reports `processing` for that
whole window and disables the mic and action buttons — a slow chain looks like a
frozen page, which is expected rather than a bug.

| Path | Purpose |
|---|---|
| `app/api/vital/route.ts` | General assistant; Gemini with roster function calling |
| `app/api/clinical-command/route.ts` | Intent classification and clinical actions |
| `app/api/transcribe/route.ts` | Audio → text; Groq Whisper with Gemini fallback |
| `app/api/patients/route.ts` | Roster list / create |
| `app/api/patients/[id]/route.ts` | Single patient read / patch / delete |
| `lib/llm-race.ts` | Latency budget, bounded retry, provider fallback. Imports no SDK — liftable verbatim |
| `lib/groq-client.ts` | Groq chat JSON and Whisper transcription |
| `lib/gemini-client.ts` | Lazily constructed Gemini client |
| `lib/clinical-intent.ts` | Transcript → structured JSON intent, Groq-primary |
| `lib/whisper-stt.ts` | Client transcription contract and transcript arbitration |
| `hooks/use-utterance-recorder.ts` | MediaRecorder lifecycle, one buffer per recorder generation |
| `lib/patient-store.ts` | Supabase persistence layer |
| `lib/patient-db.ts` | Row ↔ domain model mapping |
| `lib/auth.ts` | Roles, permission matrix, restricted-field classification |
| `lib/auth-server.ts` | Server-side caller identity; resolves role from `clinicians` |
| `components/vital-os-client.tsx` | Voice UI, admission state machine, TTS, workspace panel |
| `supabase/*.sql` | Original schema, applied before `migrations/` existed |
| `supabase/migrations/*.sql` | Ordered schema changes; run by number |
| `supabase/checks/*.sql` | Read-only verification for each migration |

---

## Scripts

```bash
npm run dev          # dev server
npm run dev:clean    # clear .next cache first (fixes most stale-build weirdness)
npm run build        # production build
npm run start        # serve the production build
npm run lint         # eslint
npm test             # all suites below
npm run test:voice   # command parser + patient identification
npm run test:llm     # race, budget, retry, fallback
npm run test:stt     # Whisper contract and transcript arbitration
```

Typecheck with the repo's own TypeScript rather than `npx tsc`, which resolves a
different install and reports a spurious `TS2882` on `globals.css`:

```bash
node node_modules/typescript/bin/tsc --noEmit
```

### Exercising the fallback path

`scripts/flaky-groq-stub.mjs` stands in for the Groq API so retry and fallback
behaviour can be driven deliberately. It implements only `/chat/completions`;
browsing to `/` returns a 404 by design.

```powershell
# terminal 1
$env:MODE="dead"        # flaky | ratelimit | dead | slow
node scripts\flaky-groq-stub.mjs

# terminal 2 — must be set before the server starts
$env:GROQ_BASE_URL="http://127.0.0.1:8787"
npm run dev
```

Then run a command and watch **Workspace → System**. Clear `GROQ_BASE_URL` and
restart the server when you're finished, or every request will keep burning the
full Groq budget before falling back.

---

## Security posture

This is a **demo application** and should not be pointed at real patient data.
It is not production-ready and makes no claim to HIPAA compliance.

**What is real:**

- Authentication is Supabase Auth. Sign-in is email and password; sessions are
  JWTs stored in cookies and refreshed server-side in `middleware.ts`, which
  verifies the token signature with `getClaims()` rather than trusting
  `getSession()`.

- Role is resolved server-side from the `clinicians` table, keyed on the
  authenticated user's id. `lib/auth-server.ts` validates the JWT with
  `getUser()` rather than decoding the cookie with `getSession()`, so a forged
  token does not produce a caller. There is no client-supplied role header: a
  request cannot assert its own privileges.
- Admissions are attributed to the authenticated clinician via
  `patients.clinician_id`, taken from the session and never from the request
  body.

**What is not yet enforced:**

- Row Level Security is **disabled** on `hospitals`, `clinicians`, and
  `patients`. Anyone holding the anon key — exposed to every browser by design —
  can read and write every row directly through PostgREST, bypassing the route
  handlers entirely. The role gate above protects the API, not the database.
- `patients.hospital_id` is not immutable. `patients` carries a table-level
  `UPDATE` grant, which implies update on every column; a column-level revoke
  cannot remove it. A client could reassign a patient's tenant through
  PostgREST.
- `user_metadata` is writable by the account holder via `auth.updateUser()`, and
  the provisioning trigger mirrors metadata into `clinicians`. Until RLS lands,
  that path is a self-service role change.

Authentication and API-level authorization are real; **database-level isolation
is not**. Closing that gap means RLS policies with `with check` on every write,
pinning `hospital_id` to the caller's tenant, enabled last — verified by
confirming a cross-tenant read returns zero rows and a cross-tenant write is
refused.

Real clinical systems authenticate staff by network ID through enterprise SSO
(SAML/OIDC against a hospital directory), not email. Supabase supports SSO;
this app does not use it, and makes no claim to hospital-grade identity.

---

## Troubleshooting

**`new row violates row-level security policy for table "patients"`**
RLS is enabled with no policies defined. Disable it:
`alter table public.patients disable row level security;`
Symptom pair to watch for: inserts throw, reads silently return zero rows.

**The app answers normally but `INTENT` shows a Gemini fallback**
The Groq model ID is retired or `GROQ_API_KEY` is unset. Check the current model
list at https://console.groq.com/docs/models and set `GROQ_INTENT_MODEL`.

**`Missing GEMINI_API_KEY environment variable` at startup**
The key is absent or `.env.local` wasn't read. Confirm the file is in the project
root (not `.env.local.txt` — Notepad appends `.txt` unless you set "Save as type"
to All Files), then restart the dev server.

**`Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY`**
Step 2 is incomplete. Both variables are required.

**Buttons stop responding for several seconds after a command**
Expected. `systemState` sits at `processing` for the duration of the provider
chain — up to 10.5 s server-side if the primary leg burns its full budget. Check
whether `GROQ_BASE_URL` is still pointed at the local stub.

**Voice button does nothing / "SpeechRecognition is not available"**
You're in Firefox or Safari. Use Chrome or Edge.

**Microphone never prompts**
`localhost` is a secure context and will prompt normally. Accessing the dev
server from another device over LAN (`http://192.168.x.x:3000`) will not — that
requires HTTPS.

**AI responds with "Access restricted" or returns 403**
You're signed in as staff. Sign out and use a doctor account.

**Stale or inexplicable build errors**
`npm run dev:clean` to clear `.next`.
