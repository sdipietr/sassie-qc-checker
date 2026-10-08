import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'sk-ant-test-secret-value';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function startMock() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      seen.push({
        url: req.url,
        headers: req.headers,
        body,
      });
      const user = body.messages?.[0]?.content || '';
      if (user.includes('ECHO_KEY')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `rejected ${req.headers['x-api-key']}` } }));
        return;
      }
      if (user.includes('NOT_JSON')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'no issues here' }] }));
        return;
      }
      if (String(body.system || '').includes('comment editor')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'text', text: 'The staff member recommended a washable paint.' }],
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [{
          type: 'text',
          text: 'Findings:\n[{"severity":"error","question":"Q2","questionText":"Staff asked questions","problem":"Binary answer is No but the comment says they asked questions."}]',
        }],
      }));
    });
  });
  return { server, seen, ready: listen(server) };
}

function startCleaner(env) {
  const child = spawn(process.execPath, ['cleaner-server.js'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cleaner did not start\nstdout:${out}\nstderr:${err}`));
    }, 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const match = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      if (out.match(/listening on/)) return;
      clearTimeout(timer);
      reject(new Error(`cleaner exited ${code}\nstdout:${out}\nstderr:${err}`));
    });
  });
  return { child, ready, output: () => out + err };
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit');
  const timer = new Promise((resolve) => setTimeout(resolve, 2000));
  await Promise.race([exited, timer]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

test('Anthropic cleaner API contract', async (t) => {
  const source = readFileSync(path.join(root, 'cleaner-server.js'), 'utf8');
  assert.equal(source.includes('openclaw'), false);
  assert.equal(source.includes('execFile'), false);

  const baseEnv = { ...process.env };
  delete baseEnv.ANTHROPIC_API_KEY;

  const noKey = startCleaner({
    ...baseEnv,
    PORT: '0',
    ANTHROPIC_API_KEY: '',
    QC_ANTHROPIC_MODEL: '',
  });
  t.after(() => stop(noKey.child));
  const noKeyPort = await noKey.ready;

  const health = await request(noKeyPort, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, provider: 'anthropic', model: 'claude-opus-5' });
  assert.equal(JSON.stringify(health.json).includes('sk-'), false);

  const cleanMissing = await request(noKeyPort, 'POST', '/api/clean-comments', {
    comment: 'The staff member asked about the room.',
  });
  assert.equal(cleanMissing.status, 503);
  assert.match(cleanMissing.json.error, /ANTHROPIC_API_KEY is not set/);
  assert.equal(cleanMissing.raw.includes('sk-'), false);

  const checkMissing = await request(noKeyPort, 'POST', '/api/check-consistency', {
    client: 'Synthetic Paint Shop',
    questions: 'Q2: Did staff ask questions? — No (0/5)',
    generalComment: 'The staff member asked several questions about the room.',
  });
  assert.equal(checkMissing.status, 503);
  assert.match(checkMissing.json.error, /AI check unavailable/);
  assert.match(checkMissing.json.error, /ANTHROPIC_API_KEY is not set/);
  assert.deepEqual(checkMissing.json.issues, []);

  const emptyComment = await request(noKeyPort, 'POST', '/api/clean-comments', { comment: '   ' });
  assert.equal(emptyComment.status, 400);
  assert.equal(emptyComment.json.error, 'comment required');

  await stop(noKey.child);

  const mock = startMock();
  const mockPort = await mock.ready;
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  const withKey = startCleaner({
    ...baseEnv,
    PORT: '0',
    ANTHROPIC_API_KEY: SECRET,
    QC_ANTHROPIC_MODEL: 'claude-opus-5',
    QC_ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
  });
  t.after(() => stop(withKey.child));
  const port = await withKey.ready;

  const healthKeyed = await request(port, 'GET', '/health');
  assert.equal(healthKeyed.status, 200);
  assert.deepEqual(healthKeyed.json, { ok: true, provider: 'anthropic', model: 'claude-opus-5' });
  assert.equal(healthKeyed.raw.includes(SECRET), false);
  assert.equal(withKey.output().includes(SECRET), false);

  const cleaned = await request(port, 'POST', '/api/clean-comments', {
    comment: 'the staff member recommend a washable paint',
  });
  assert.equal(cleaned.status, 200);
  assert.deepEqual(Object.keys(cleaned.json).sort(), ['cleaned']);
  assert.equal(cleaned.json.cleaned, 'The staff member recommended a washable paint.');

  const issues = await request(port, 'POST', '/api/check-consistency', {
    client: 'Synthetic Paint Shop',
    questions: 'Q2: Did the staff member ask questions? — No (0/5)',
    generalComment: 'The staff member asked several questions about the room size.',
  });
  assert.equal(issues.status, 200);
  assert.deepEqual(Object.keys(issues.json).sort(), ['issues']);
  assert.equal(issues.json.issues.length, 1);
  assert.equal(issues.json.issues[0].question, 'Q2');
  assert.equal(issues.json.issues[0].severity, 'error');

  const cleanReq = mock.seen.find((r) => String(r.body.system || '').includes('comment editor'));
  const checkReq = mock.seen.find((r) => String(r.body.system || '').includes('quality control checker'));
  assert.ok(cleanReq, 'cleaner call reached Anthropic');
  assert.ok(checkReq, 'consistency call reached Anthropic');
  for (const hit of [cleanReq, checkReq]) {
    assert.equal(hit.url, '/v1/messages');
    assert.equal(hit.headers['x-api-key'], SECRET);
    assert.equal(hit.headers['anthropic-version'], '2023-06-01');
    assert.equal(hit.body.model, 'claude-opus-5');
    assert.equal(hit.body.messages[0].role, 'user');
  }
  assert.match(cleanReq.body.messages[0].content, /Comment to clean:/);
  assert.match(checkReq.body.messages[0].content, /General Comment:/);

  const echoed = await request(port, 'POST', '/api/clean-comments', { comment: 'ECHO_KEY please' });
  assert.equal(echoed.status, 401);
  assert.match(echoed.json.error, /rejected \[redacted\]/);
  assert.equal(echoed.raw.includes(SECRET), false);

  const badModel = await request(port, 'POST', '/api/check-consistency', {
    client: 'Synthetic Paint Shop',
    questions: 'Q1: Greeting — Yes (5/5)',
    generalComment: 'NOT_JSON the visit was ordinary.',
  });
  assert.equal(badModel.status, 502);
  assert.match(badModel.json.error, /AI check unavailable/);
  assert.match(badModel.json.error, /JSON array/);
  assert.deepEqual(badModel.json.issues, []);
});
