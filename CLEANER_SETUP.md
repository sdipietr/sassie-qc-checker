# Cleaner API setup (Mac mini)

This adds automatic AI comment cleaning (Original + Cleaned) to the checker UI.

## 1) Install backend deps

```bash
cd ~/path/to/sassie-qc-checker
npm install
```

## 2) Set API key and run server

```bash
export OPENAI_API_KEY="YOUR_KEY"
npm run cleaner
```

Server runs at: `http://127.0.0.1:8787`

## 3) Use the site

Open the GitHub Pages site, upload report PDF.
The app will automatically call the cleaner API and show:
- Original comment
- Cleaned comment
- Copy cleaned for SASSIE

If backend is down, it falls back to showing original text.
