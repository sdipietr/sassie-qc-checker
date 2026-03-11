# Cleaner API setup (Mac mini) — OpenClaw OAuth mode

This uses your existing OpenClaw OAuth session (no OpenAI API key required).

## 1) Install backend deps

```bash
cd ~/path/to/sassie-qc-checker
npm install
```

## 2) Ensure OpenClaw OAuth is working

```bash
openclaw status
```

## 3) Run cleaner server

```bash
npm run cleaner
```

Server runs at: `http://127.0.0.1:8787`

## 4) Use the site

Open the GitHub Pages site, upload report PDF.
The app will automatically call the cleaner API and show:
- Original comment
- Cleaned comment
- Copy cleaned for SASSIE

If backend is down, it falls back to showing original text.

## Model choice note
Cleaner is configured to use dedicated OpenClaw agent `cleaner` (OAuth) so your main default can stay on Codex 5.3.
Current cleaner model: `openai/gpt-4o`.

Optional override:
```bash
CLEANER_AGENT_ID=cleaner npm run cleaner
```
