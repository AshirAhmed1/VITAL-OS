# VITAL OS

> Speech-first clinical support.
> Browser microphone → LLM → browser speaker.

A voice-controlled clinical assistant for hospital floor work: admit and discharge
patients, pull up charts, draft medication orders, and ask clinical questions —
all by speaking. Built with Next.js 14 (App Router), TypeScript, Supabase, and
Google Gemini.

---

## Requirements

| | |
|---|---|
| **Node.js** | 18.17+ (Node 20 LTS recommended — it's what Vercel runs) |
| **Browser** | Chrome or Edge. The voice path uses `webkitSpeechRecognition`, which Firefox and Safari do not implement. |
| **Gemini API key** | https://aistudio.google.com/apikey |
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
| `GEMINI_CLINICAL_MODEL` | no | Defaults to `gemini-2.0-flash` |

Use the **`anon` / `public`** Supabase key, never the `service_role` key. The
`NEXT_PUBLIC_` prefix ships that value to every browser that loads the app.

Next.js reads `.env.local` only at startup — restart the dev server after editing it.

### 3. Set up the database

The patient roster is persisted in Supabase Postgres, not on disk. Without this
step the roster, chart views, and every AI turn that touches patient data will fail.

In your Supabase dashboard → **SQL Editor** → **New query**, run these two files
from this repo, in order:

1. **`supabase/patients.sql`** — creates the `patients` table, indexes, the
   `updated_at` trigger, and role grants
2. **`supabase/add_patient_voice_fields.sql`** — additive columns for chart notes
   and discharge tracking

Both are idempotent (`if not exists` throughout), so re-running either is safe.
`Success. No rows returned` is the expected output — DDL doesn't return rows.

Ignore the other two SQL files:
`merge_symptoms_into_problems.sql` is marked deprecated in its own header, and
`reset_problems_diagnoses_only.sql` is a data reset, not a schema step.

> **If Supabase prompts you to "Enable RLS", decline it.** This demo runs with
> Row Level Security disabled and CRUD granted to the `anon` role — see
> [Security posture](#security-posture) below. Enabling RLS without policies
> blocks every insert and silently returns zero rows on read.

You do **not** need to seed data manually. The first call to `listPatients()`
runs `seedDemoPatientsIfEmpty()` and inserts the demo roster automatically.

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3000** in Chrome or Edge and allow microphone access
when prompted.

### 5. Sign in

Credentials are hardcoded in `lib/auth.ts` (demo only — not real authentication):

| Role | Name | ID | Access |
|---|---|---|---|
| Doctor | `Eknoor Sidhu` | `74321` | Full — AI assistant enabled |
| Doctor | `Ashir Ahmed` | `98768` | Full — AI assistant enabled |
| Staff | `Gurdit Johal` | `54321` | Read-only — AI routes return 403 |

Use a doctor account. `/api/vital` and `/api/clinical-command` hard-reject
anything that isn't `role === "doctor"`.

---

## Verify your setup

With the dev server running, in a second terminal:

```bash
curl http://localhost:3000/api/vital      # expect hasApiKey: true, rosterPatients > 0
curl http://localhost:3000/api/patients   # expect a roster array
```

On Windows PowerShell use `curl.exe` explicitly — bare `curl` is an alias for
`Invoke-WebRequest` and takes different flags.

If `/api/vital` reports `rosterPatients: 0` but `/api/patients` returns patients,
that's harmless: the status endpoint swallows errors and reports zero. If
`/api/patients` errors, it surfaces the real Postgres message — read that first.

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
Browser mic (SpeechRecognition)
  → /api/clinical-command   → lib/clinical-intent.ts    transcript → structured JSON intent
                            → lib/clinical-reasoning.ts differential / clinical Q&A
  → /api/vital              → lib/vital-llm.ts          general assistant + roster tool calls
  → /api/patients           → lib/patient-store.ts      Supabase CRUD
Browser speaker (SpeechSynthesis)
```

| Path | Purpose |
|---|---|
| `app/api/vital/route.ts` | General assistant; Gemini with roster function calling |
| `app/api/clinical-command/route.ts` | Intent classification and clinical actions |
| `app/api/patients/route.ts` | Roster list / create |
| `app/api/patients/[id]/route.ts` | Single patient read / patch / delete |
| `lib/clinical-intent.ts` | Transcript → structured JSON intent |
| `lib/patient-store.ts` | Supabase persistence layer |
| `lib/patient-db.ts` | Row ↔ domain model mapping |
| `lib/auth.ts` | Demo credentials, roles, permission matrix |
| `components/vital-os-client.tsx` | Voice UI, admission state machine, TTS |
| `supabase/*.sql` | Schema and migrations |

---

## Scripts

```bash
npm run dev          # dev server
npm run dev:clean    # clear .next cache first (fixes most stale-build weirdness)
npm run build        # production build
npm run start        # serve the production build
npm run lint         # eslint
npm run test:voice   # command parser + patient identification specs
```

---

## Security posture

This is a **demo application** and should not be pointed at real patient data.

- Authentication is hardcoded name/ID pairs in `lib/auth.ts` with no sessions,
  password hashing, or token verification.
- Row Level Security is **disabled** on `public.patients`, with full CRUD granted
  to the `anon` role. Anyone holding the anon key — which is exposed to every
  browser by design — can read and write every row.
- Role gating is enforced in route handlers via an `x-vital-role` header, which
  a client can trivially set itself.

Hardening this means real Supabase Auth sessions, RLS policies scoped to the
authenticated clinician, and JWT verification in middleware.

---

## Troubleshooting

**`new row violates row-level security policy for table "patients"`**
RLS is enabled with no policies defined. Disable it:
`alter table public.patients disable row level security;`
Symptom pair to watch for: inserts throw, reads silently return zero rows.

**`Missing GEMINI_API_KEY environment variable` at startup**
The key is absent or `.env.local` wasn't read. Confirm the file is in the project
root (not `.env.local.txt` — Notepad appends `.txt` unless you set "Save as type"
to All Files), then restart the dev server.

**`Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY`**
Step 2 is incomplete. Both variables are required.

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
