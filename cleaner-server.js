#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { execFile } from 'node:child_process';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('.'));

const port = process.env.PORT || 8787;
const sessionId = process.env.CLEANER_SESSION_ID || 'sassie-cleaner';
const agentId = process.env.CLEANER_AGENT_ID || 'cleaner';

// ── Shared OpenClaw agent runner ──────────────────────────────────────────────
function runAgent(message) {
  return new Promise((resolve, reject) => {
    execFile(
      'openclaw',
      ['agent', '--agent', agentId, '--session-id', sessionId, '--message', message, '--json'],
      { timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          const data = JSON.parse(stdout);
          const text = data?.result?.payloads?.[0]?.text?.trim();
          if (!text) return reject(new Error('No text returned from OpenClaw agent'));
          resolve(text);
        } catch (e) {
          reject(new Error('Failed parsing OpenClaw agent response'));
        }
      }
    );
  });
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, mode: 'openclaw-oauth', sessionId, agentId }));

// ── Comment cleaner ───────────────────────────────────────────────────────────
const CLEANER_SYSTEM = `You are a mystery shopping comment editor. Clean grammar, spelling, punctuation, and clarity only.
Preserve the shopper's voice, tone, meaning, and approximate length.
Do not add or remove facts.
Avoid AI-sounding stock phrases.
Return only the cleaned comment text.`;

app.post('/api/clean-comments', async (req, res) => {
  try {
    const comment = (req.body?.comment || '').toString().trim();
    if (!comment) return res.status(400).json({ error: 'comment required' });
    const cleaned = await runAgent(`${CLEANER_SYSTEM}\n\nComment to clean:\n${comment}`);
    res.json({ cleaned });
  } catch (err) {
    res.status(500).json({ error: err.message || 'cleaning failed' });
  }
});

// ── AI consistency checker ────────────────────────────────────────────────────
const CONSISTENCY_SYSTEM = `You are a quality control checker for mystery shopping reports.

You will be given a list of survey questions with their binary scores (Yes/No) and a General Comment written by the shopper.

Your job: identify inconsistencies where the General Comment contradicts the binary answers.

An inconsistency is when:
- The binary answer is "No" (scored 0) but the comment claims the thing happened
- The binary answer is "Yes" (full score) but the comment says it didn't happen or describes a negative experience
- The comment describes something in detail that the binary answer says didn't occur

Return ONLY a valid JSON array. Each item must have:
- "severity": "error" or "warning"
- "question": the question number e.g. "Q3", or a short label
- "questionText": a brief description of what the question asks
- "problem": a clear, specific explanation of the inconsistency, quoting the relevant part of the comment

If no inconsistencies are found, return an empty array: []

Only flag genuine contradictions — do not flag things the algorithm would already catch from scores alone.`;

app.post('/api/check-consistency', async (req, res) => {
  try {
    const { client, questions, generalComment } = req.body;
    if (!questions || !generalComment) {
      return res.status(400).json({ error: 'questions and generalComment required', issues: [] });
    }

    const prompt = `${CONSISTENCY_SYSTEM}

Survey: ${client || 'Unknown'}

Questions and scores:
${questions}

General Comment:
${generalComment}`;

    const raw = await runAgent(prompt);

    // Extract the JSON array from the response (agent may wrap it in prose)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ issues: [] });

    let issues;
    try {
      issues = JSON.parse(jsonMatch[0]);
    } catch (_) {
      return res.json({ issues: [] });
    }

    res.json({ issues: Array.isArray(issues) ? issues : [] });
  } catch (err) {
    // Fail gracefully — frontend will just show no AI issues
    res.status(500).json({ error: err.message || 'consistency check failed', issues: [] });
  }
});

app.listen(port, () => {
  console.log(`SASSIE cleaner API (OpenClaw OAuth) listening on http://127.0.0.1:${port}`);
});
