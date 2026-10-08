#!/usr/bin/env node
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('.'));

const port = process.env.PORT || 8787;
const model = process.env.QC_ANTHROPIC_MODEL || 'claude-opus-5';
const anthropicBase = (process.env.QC_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

function apiKey() {
  return (process.env.ANTHROPIC_API_KEY || '').trim();
}

function publicMessage(err) {
  let message = err?.message || 'request failed';
  const key = apiKey();
  if (key) message = message.split(key).join('[redacted]');
  return message;
}

function fail(res, err, { consistency = false } = {}) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  let message = publicMessage(err);
  if (consistency && !/AI check unavailable/i.test(message)) {
    message = `AI check unavailable: ${message}`;
  }
  const body = { error: message };
  if (consistency) body.issues = [];
  res.status(status).json(body);
}

async function callClaude({ system, user }) {
  const key = apiKey();
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY is not set');
    err.status = 503;
    throw err;
  }

  let response;
  try {
    response = await fetch(`${anthropicBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const wrapped = new Error(timedOut ? 'Anthropic request timed out' : (err?.message || 'Anthropic request failed'));
    wrapped.status = timedOut ? 504 : 502;
    throw wrapped;
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || response.statusText || 'Anthropic request failed';
    const err = new Error(detail);
    err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw err;
  }

  const text = (Array.isArray(body.content) ? body.content : [])
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) {
    const err = new Error('No text returned from Claude');
    err.status = 502;
    throw err;
  }
  return text;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, provider: 'anthropic', model });
});

const CLEANER_SYSTEM = `You are a mystery shopping comment editor. Clean grammar, spelling, punctuation, and clarity only.
Preserve the shopper's voice, tone, meaning, and approximate length.
Do not add or remove facts.
Avoid AI-sounding stock phrases.
Return only the cleaned comment text.`;

app.post('/api/clean-comments', async (req, res) => {
  try {
    const comment = (req.body?.comment || '').toString().trim();
    if (!comment) return res.status(400).json({ error: 'comment required' });
    const cleaned = await callClaude({
      system: CLEANER_SYSTEM,
      user: `Comment to clean:\n${comment}`,
    });
    res.json({ cleaned });
  } catch (err) {
    fail(res, err);
  }
});

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
    const { client, questions, generalComment } = req.body || {};
    if (!questions || !generalComment) {
      return res.status(400).json({
        error: 'AI check unavailable: questions and generalComment required',
        issues: [],
      });
    }

    const raw = await callClaude({
      system: CONSISTENCY_SYSTEM,
      user: `Survey: ${client || 'Unknown'}

Questions and scores:
${questions}

General Comment:
${generalComment}`,
    });

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      const err = new Error('model response did not include a JSON array');
      err.status = 502;
      throw err;
    }

    let issues;
    try {
      issues = JSON.parse(jsonMatch[0]);
    } catch (_) {
      const err = new Error('model response was not valid JSON');
      err.status = 502;
      throw err;
    }
    if (!Array.isArray(issues)) {
      const err = new Error('model response was not a JSON array');
      err.status = 502;
      throw err;
    }

    res.json({ issues });
  } catch (err) {
    fail(res, err, { consistency: true });
  }
});

const server = app.listen(port, () => {
  const bound = server.address();
  const shown = bound && typeof bound === 'object' ? bound.port : port;
  console.log(`SASSIE cleaner API (Anthropic) listening on http://127.0.0.1:${shown}`);
});
