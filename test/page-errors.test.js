import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function startCleaner() {
  const env = { ...process.env, PORT: '0' };
  delete env.ANTHROPIC_API_KEY;
  const child = spawn(process.execPath, ['cleaner-server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cleaner did not start\n${out}\n${err}`)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const match = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { child, ready };
}

function startPage(cleanerOrigin) {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8').replace(
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>',
    `<script>
      var pdfjsLib = { GlobalWorkerOptions: {} };
      window.CLEANER_API = ${JSON.stringify(cleanerOrigin + '/api/clean-comments')};
      window.CONSISTENCY_API = ${JSON.stringify(cleanerOrigin + '/api/check-consistency')};
    </script>`
  );
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return { server, html, ready: listen(server) };
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('devtools websocket failed')));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  return {
    ws,
    async send(method, params = {}) {
      await opened;
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
  };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

test('page shows AI and cleaner errors when the API fails', { timeout: 60000 }, async (t) => {
  const cleaner = startCleaner();
  t.after(() => stop(cleaner.child));
  const cleanerPort = await cleaner.ready;
  const page = startPage(`http://127.0.0.1:${cleanerPort}`);
  t.after(() => new Promise((resolve) => page.server.close(resolve)));
  const pagePort = await page.ready;

  const profile = `/tmp/chrome-qc-${process.pid}`;
  const chrome = spawn('google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => stop(chrome));

  let chromeLog = '';
  const debugPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chrome did not start\n${chromeLog}`)), 15000);
    chrome.stderr.on('data', (d) => {
      chromeLog += d;
      const match = chromeLog.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });

  const list = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${pagePort}/`)}`, { method: 'PUT' });
  const target = await list.json();
  const client = cdp(target.webSocketDebuggerUrl);
  t.after(() => client.ws.close());

  let ready = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      ready = await client.send('Runtime.evaluate', {
        expression: `new Promise((resolve) => {
          const start = Date.now();
          const tick = () => {
            if (typeof renderResults === 'function' && typeof aiCheckConsistency === 'function') resolve('ready');
            else if (Date.now() - start > 8000) resolve('timeout');
            else setTimeout(tick, 40);
          };
          tick();
        })`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (ready.result?.value === 'ready') break;
    } catch (err) {
      const message = String(err.message || err);
      if (!/destroyed|context/i.test(message)) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(ready?.result?.value, 'ready');

  const shown = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const report = {
        client: 'Synthetic Paint Shop',
        shopRef: '1001',
        shopper: 'Example Shopper',
        overallScore: 70,
        sections: [{ name: 'Assistance', percentage: 70 }],
        questions: [{ number: 2, text: 'Did the staff member ask questions?', answer: 'No', scored: 0, total: 5 }],
        generalComment: 'The staff member asked several questions about the room size and then suggested a washable paint.'
      };
      renderResults(report, [], 'synthetic report text');
      const ai = await aiCheckConsistency(report);
      appendAIIssues(ai);
      await autoCleanGeneralComment(report.generalComment);
      return {
        ai: document.getElementById('aiCheckStatus').textContent,
        cleaner: document.getElementById('cleanerStatus').textContent,
        macMini: document.body.innerText.includes('Mac mini')
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(shown.exceptionDetails, undefined);
  const value = shown.result.value;
  assert.match(value.ai, /AI check unavailable/);
  assert.match(value.ai, /ANTHROPIC_API_KEY is not set/);
  assert.doesNotMatch(value.ai, /no additional issues/i);
  assert.match(value.cleaner, /Cleaner unavailable/);
  assert.match(value.cleaner, /ANTHROPIC_API_KEY is not set/);
  assert.doesNotMatch(value.cleaner, /Mac mini/);
  assert.equal(value.macMini, false);

  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  try {
    mkdirSync('/opt/cursor/artifacts', { recursive: true });
    writeFileSync('/opt/cursor/artifacts/ai-check-unavailable.png', Buffer.from(shot.data, 'base64'));
  } catch (_) {
    // Local evidence only; the assertions above are the contract.
  }
});
