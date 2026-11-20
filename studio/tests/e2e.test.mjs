import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

function connectWs(port, cookie, origin) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\nOrigin: ${origin}\r\n\r\n`
      );
    });
    let upgraded = false;
    let buf = Buffer.alloc(0);
    const events = [];

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString('utf8');
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error(`WS rejected: ${head}`));
          return;
        }
        buf = buf.subarray(idx + 4);
        upgraded = true;
        resolve({ sock, events });
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) break;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x01) {
          try { events.push(JSON.parse(payload.toString('utf8'))); } catch { /* ignore */ }
        }
      }
    });
    sock.on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for E2E condition');
}

test('E2E: dashboard assets, sandboxed iframe, live mock Abliteration.ai provider, 3-tier Subordinate -> Coordinator -> Anatomical Illustrator workflow', async () => {
  const dataDir = makeTempDir('sp-e2e-data-');
  const workDir = makeTempDir('sp-e2e-work-');

  // Local mock OpenAI-compatible provider (simulates Abliteration.ai with SSE + tool_calls + reasoning)
  let coordCalls = 0;
  const mockLlm = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'abliterated-coder-v1' }] }));
      return;
    }
    const body = JSON.parse(await readBody(req));
    const sys = body.messages?.[0]?.content || '';
    const lastRole = body.messages?.[body.messages.length - 1]?.role;

    const sendSse = (chunks) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };

    if (sys.includes('Role: Subordinate')) {
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
      if (lastRole === 'tool') {
        return sendSse([
          { choices: [{ delta: { content: 'Mockup pushed and rules drafted — click Approve & Dispatch!' }, finish_reason: 'stop' }] },
        ]);
      }
      if (lastUser.includes('Coordinator reported completion')) {
        return sendSse([
          { choices: [{ delta: { content: 'All done! Your anatomical heart diagram SVG is saved and displayed.' }, finish_reason: 'stop' }] },
        ]);
      }
      return sendSse([
        { choices: [{ delta: { reasoning_content: 'Preparing visual mockup and rules' }, finish_reason: null }] },
        {
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_vis',
                  type: 'function',
                  function: {
                    name: 'push_visual_screen',
                    arguments: JSON.stringify({ filename: '01-plan.html', html: '<h2>Choose View Plane</h2><div class="options"><div class="option" data-choice="coronal" onclick="toggleSelect(this)">Coronal</div></div>' }),
                  },
                },
                {
                  index: 1,
                  id: 'call_rules',
                  type: 'function',
                  function: {
                    name: 'propose_rules',
                    arguments: JSON.stringify({ rulesMarkdown: '- Label cardiac chambers accurately', planMarkdown: '1. Dispatch Anatomical Illustrator to create heart.svg' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        },
      ]);
    }

    if (sys.includes('Role: Coordinator')) {
      coordCalls++;
      if (coordCalls === 1) {
        return sendSse([
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_exp',
                  type: 'function',
                  function: {
                    name: 'spawn_expert',
                    arguments: JSON.stringify({ expertId: 'anatomical-illustrator', task: 'Create heart.svg in workspace' }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          },
        ]);
      }
      return sendSse([
        {
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_prog',
                  type: 'function',
                  function: {
                    name: 'update_task_progress',
                    arguments: JSON.stringify({ taskId: 'task-1', status: 'done', note: 'heart.svg verified' }),
                  },
                },
                {
                  index: 1,
                  id: 'call_fin',
                  type: 'function',
                  function: {
                    name: 'report_complete',
                    arguments: JSON.stringify({ summary: 'Created heart.svg via Anatomical Illustrator', verification: 'File written' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        },
      ]);
    }

    // Anatomical Illustrator Expert
    if (lastRole === 'tool') {
      return sendSse([
        { choices: [{ delta: { content: 'Saved heart.svg with coronal view labels.' }, finish_reason: 'stop' }] },
      ]);
    }
    return sendSse([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_wf',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: 'heart.svg', content: '<svg><title>Coronal Heart</title></svg>' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ]);
  });

  await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r));
  const llmPort = mockLlm.address().port;

  const studio = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${studio.port}`;

  try {
    // 1. Load index.html and verify sandboxed iframe & static assets
    const idxRes = await fetch(`${base}/?token=${studio.token}`);
    assert.equal(idxRes.status, 200);
    const cookie = (idxRes.headers.get('set-cookie') || '').split(';')[0];
    const indexHtml = await idxRes.text();
    assert.match(indexHtml, /<iframe[^>]*sandbox="allow-scripts"/);
    assert.ok(!indexHtml.includes('allow-same-origin'), 'iframe MUST NOT have allow-same-origin');

    const cssRes = await fetch(`${base}/styles.css`, { headers: { Cookie: cookie } });
    assert.equal(cssRes.status, 200);
    const jsRes = await fetch(`${base}/app.js`, { headers: { Cookie: cookie } });
    assert.equal(jsRes.status, 200);

    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
    const ws = await connectWs(studio.port, cookie, base);

    try {
      // 2. Point Abliteration.ai provider at local mock LLM and discover models
      await fetch(`${base}/api/providers/abliteration`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ baseUrl: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'ak_e2e', defaultModel: 'abliterated-coder-v1' }),
      });
      const models = await (await fetch(`${base}/api/providers/abliteration/models`, { headers })).json();
      assert.deepEqual(models.models, ['abliterated-coder-v1']);

      // 3. Create session & interview Subordinate
      const { session } = await (await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Cardiac Atlas', workspacePath: workDir, providerId: 'abliteration', model: 'abliterated-coder-v1' }),
      })).json();

      await fetch(`${base}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content: 'Create a labeled coronal cardiac diagram' }),
      });

      // Verify companion screen pushed + click event persisted
      const compHtml = await (await fetch(`${base}/api/sessions/${session.id}/companion`, { headers: { Cookie: cookie } })).text();
      assert.match(compHtml, /Choose View Plane/);
      await fetch(`${base}/api/sessions/${session.id}/companion/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'click', choice: 'coronal' }),
      });

      // 4. Approve & dispatch to Coordinator -> Anatomical Illustrator -> Completion
      const appRes = await fetch(`${base}/api/sessions/${session.id}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      assert.equal(appRes.status, 200);

      await waitFor(
        () => ws.events.some((e) => e.type === 'session_updated' && e.session?.id === session.id && e.session?.phase === 'completed'),
        6000
      );

      assert.equal(fs.readFileSync(path.join(workDir, 'heart.svg'), 'utf8'), '<svg><title>Coronal Heart</title></svg>');
      assert.ok(ws.events.some((e) => e.type === 'companion_reload'));
      assert.ok(ws.events.some((e) => e.type === 'coordinator_event'));
      assert.ok(ws.events.some((e) => e.type === 'expert_event' && e.status === 'completed'));
    } finally {
      ws.sock.destroy();
    }
  } finally {
    await studio.close();
    await new Promise((r) => mockLlm.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
