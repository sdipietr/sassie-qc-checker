# Cleaner API setup

The QC checker calls Claude through the Anthropic Messages API. `ANTHROPIC_API_KEY` is required. Do not commit the key or put it in this repo.

## 1) Install backend deps

```bash
cd ~/path/to/sassie-qc-checker
npm install
```

## 2) Configure

```bash
export ANTHROPIC_API_KEY=your-key-here
```

Optional model override (default `claude-opus-5`):

```bash
export QC_ANTHROPIC_MODEL=claude-opus-5
```

## 3) Run cleaner server

```bash
npm run cleaner
```

Server runs at: `http://127.0.0.1:8787`

`GET /health` returns `{ "ok": true, "provider": "anthropic", "model": "..." }` and never includes the API key.

## 4) Use the site

Open the site and upload a shopper report PDF. The page calls:

- `POST /api/clean-comments` → `{ "cleaned": "..." }`
- `POST /api/check-consistency` → `{ "issues": [ ... ] }`

If the key is missing or Claude cannot be reached, the page shows **AI check unavailable** with the reason, and the cleaner shows **Cleaner unavailable** with the reason, instead of a silent empty result.
