#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { execFile } from 'node:child_process';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const port = process.env.PORT || 8787;
const sessionId = process.env.CLEANER_SESSION_ID || 'sassie-cleaner';
const agentId = process.env.CLEANER_AGENT_ID || 'cleaner';

const SYSTEM_PROMPT = `You are a mystery shopping comment editor. Clean grammar, spelling, punctuation, and clarity only.
Preserve the shopper's voice, tone, meaning, and approximate length.
Do not add or remove facts.
Avoid AI-sounding stock phrases.
Return only the cleaned comment text.`;

app.get('/health', (_req, res) => res.json({ ok: true, mode: 'openclaw-oauth', sessionId, agentId }));

function runAgent(message) {
  return new Promise((resolve, reject) => {
    execFile('openclaw', ['agent', '--agent', agentId, '--session-id', sessionId, '--message', message, '--json'], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const data = JSON.parse(stdout);
        const text = data?.result?.payloads?.[0]?.text?.trim();
        if (!text) return reject(new Error('No text returned from OpenClaw agent'));
        resolve(text);
      } catch (e) {
        reject(new Error('Failed parsing OpenClaw agent response'));
      }
    });
  });
}

app.post('/api/clean-comments', async (req, res) => {
  try {
    const comment = (req.body?.comment || '').toString().trim();
    if (!comment) return res.status(400).json({ error: 'comment required' });

    const prompt = `${SYSTEM_PROMPT}

Comment to clean:
${comment}`;
    const cleaned = await runAgent(prompt);
    res.json({ cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message || 'cleaning failed' });
  }
});

app.listen(port, () => {
  console.log(`SASSIE cleaner API (OpenClaw OAuth) listening on http://127.0.0.1:${port}`);
});
