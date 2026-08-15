# VITAL OS

> Speech-first clinical support.
> Browser microphone -> Google Gemini -> browser speaker.

## Setup

1. Get a Gemini API key: https://aistudio.google.com/apikey
2. Put it in `.env.local`:

```env
GEMINI_API_KEY=your_key_here
```

3. Restart dev server:

```bash
npm run dev
```

## Notes

- Uses browser SpeechRecognition for STT and browser SpeechSynthesis for TTS.
- `/api/vital` calls Google Gemini (`gemini-1.5-flash`) generateContent.
- Patient roster is persisted in `data/patients.json`.


## Try It Yourself

VITAL-OS is fully voice-controlled — here's how to test the core features:

1. Click the **voice activation** (unmute) button to start listening.
2. Say **"Hey Vital, admit patient [name]"** and follow the prompts for patient info (age, symptoms, triage level, etc.).
3. Once admitted, try: **"Hey Vital, discharge [patient name]"** to remove a patient from the current triage list.
4. You can also ask things like:
   - *"Hey Vital, what's the status of [patient name]?"*
   - *"Hey Vital, show me all patients in triage."*
   - *"Hey Vital, update [patient name]'s condition to [X]."*

Speak naturally — VITAL-OS is built to understand conversational phrasing, not rigid commands.