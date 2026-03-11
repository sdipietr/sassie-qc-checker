#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const port = process.env.PORT || 8787;
const model = process.env.CLEANER_MODEL || 'gpt-4.1-mini';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a mystery shopping comment editor. Clean grammar, spelling, punctuation, and clarity only.
Preserve the shopper's voice, tone, meaning, and approximate length.
Do not add or remove facts.
Avoid AI-sounding stock phrases.
Return only the cleaned comment text.`;

app.get('/health', (_req, res) => res.json({ ok: true, model }));

app.post('/api/clean-comments', async (req, res) => {
  try {
    const comment = (req.body?.comment || '').toString().trim();
    if (!comment) return res.status(400).json({ error: 'comment required' });

    const completion = await client.responses.create({
      model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: comment }
      ],
      max_output_tokens: 600,
      temperature: 0.1
    });

    const cleaned = completion.output_text?.trim() || comment;
    res.json({ cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message || 'cleaning failed' });
  }
});

app.listen(port, () => {
  console.log(`SASSIE cleaner API listening on http://127.0.0.1:${port}`);
});
