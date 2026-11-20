import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { prepareSessionWorkspace } from '../lib/worktree.mjs';
import { createToolExecutor } from '../lib/tools.mjs';
import { createOrchestrator, parsePlanTasks, computeMissionEta } from '../lib/orchestrator.mjs';
import { streamChat } from '../lib/providers/index.mjs';
import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

// 1x1 transparent PNG base64
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function makeTempDir(prefix = 'sp-p14-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Phase 1: missing workspace is auto-created and resolveScopedPath does not falsely report symlink escape', async () => {
  const base = makeTempDir('sp-p1-');
  const dataDir = path.join(base, 'data');
  const newWorkspace = path.join(base, 'New_Project_Workspace');
  try {
    assert.equal(fs.existsSync(newWorkspace), false);
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'New Folder', workspacePath: newWorkspace });
    assert.equal(fs.existsSync(newWorkspace), true, 'createSession should auto-create missing workspace');

    // Also verify prepareSessionWorkspace auto-creates if deleted later
    fs.rmSync(newWorkspace, { recursive: true, force: true });
    assert.equal(fs.existsSync(newWorkspace), false);
    const prep = await prepareSessionWorkspace({ session, activeSessions: [], dataDir });
    assert.equal(fs.existsSync(prep.effectiveWorkDir), true);

    // And resolveScopedPath works on non-existent nested dir without false symlink error
    const missingRoot = path.join(base, 'brand_new_ws');
    const exec = createToolExecutor({
      store,
      skillsRoot: SKILLS_ROOT,
      session,
      effectiveWorkDir: missingRoot,
    });
    const listRes = await exec.execute('list_files', { path: '.' });
    assert.equal(listRes.ok, true, `unexpected error: ${listRes.output}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Phase 1 & 2: transcript fallback on empty rules/plan, plan task parsing, update_task_progress, and ETA calculation', async () => {
  const parsed = parsePlanTasks(`
# Plan
### Task 1: Upgrade style-defs.svg
- [ ] Step 1
### Task 2: Build UI component SVG
### Task 3: Render PNG gallery
`);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].title, 'Upgrade style-defs.svg');
  assert.equal(parsed[0].status, 'pending');

  // ETA computed from rolling average of completed tasks
  const eta1 = computeMissionEta([
    { status: 'done', durationMs: 60_000 },
    { status: 'in_progress', estimateSec: 90 },
    { status: 'pending' },
  ]);
  assert.equal(eta1.doneCount, 1);
  assert.equal(eta1.totalCount, 3);
  assert.equal(eta1.etaSeconds, 120); // 60s avg * 2 remaining

  // ETA computed from estimates when 0 tasks completed
  const eta2 = computeMissionEta([
    { status: 'in_progress', estimateSec: 45 },
    { status: 'pending', estimateSec: 75 },
  ]);
  assert.equal(eta2.etaSeconds, 120);

  // Empty rules/plan approval pulls drafted plan from Subordinate messages + Coordinator updates task progress
  const base = makeTempDir('sp-p2-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'Fallback Plan', workspacePath: workDir, providerId: 'abliteration', model: 'm' });
    store.appendMessage(session.id, { role: 'user', content: 'Plan SVG diagram assets' });
    store.appendMessage(session.id, {
      role: 'assistant',
      content: '# Diagram Plan\n### Task 1: Create style-defs\n### Task 2: Build base SVG',
    });

    let coordTurn = 0;
    let sawFallbackPlan = false;
    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          coordTurn++;
          if (systemPrompt.includes('Create style-defs')) sawFallbackPlan = true;
          if (coordTurn === 1) {
            return {
              content: 'Starting Task 1',
              reasoning: '',
              toolCalls: [
                { id: 't1', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'in_progress', assignedAgent: 'Anatomical Illustrator', estimateSec: 60 } },
              ],
            };
          }
          if (coordTurn === 2) {
            return {
              content: 'Task 1 done',
              reasoning: '',
              toolCalls: [
                { id: 't2', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
                { id: 't2b', name: 'update_task_progress', arguments: { taskId: 'task-2', status: 'done' } },
                { id: 't3', name: 'report_complete', arguments: { summary: 'All done', verification: 'OK' } },
              ],
            };
          }
        }
        return { content: 'Summary ready.', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    // Approve with empty rules/plan — should auto-populate from Subordinate transcript and parse 2 tasks!
    await orch.approveAndRun(session.id, { rules: '', plan: '' });
    const start = Date.now();
    while (Date.now() - start < 5000 && store.getSession(session.id).phase !== 'completed') {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(sawFallbackPlan, true, 'Coordinator should receive transcript fallback plan');
    const updated = store.getSession(session.id);
    assert.equal(updated.tasks.length, 2);
    assert.equal(updated.tasks[0].status, 'done');
    assert.equal(updated.tasks[0].assignedAgent, 'Anatomical Illustrator');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Phase 4: multimodal image attachments across OpenAI-compat (with text-only fallback), Anthropic, and Gemini + HTTP attachment upload/serving', async () => {
  const seen = { openai: [], anthropic: [], gemini: [] };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (req.url.includes('/v1/chat/completions')) {
        seen.openai.push(body);
        // First model rejects image_url; verify graceful text fallback retry!
        if (body.model === 'text-only-ablit' && Array.isArray(body.messages.at(-1)?.content)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'This model does not support image_url multimodal input' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Saw image' }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (req.url.includes('/v1/messages')) {
        seen.anthropic.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'Saw Claude img' } })}\n\n`);
        res.write(`event: message_stop\ndata: {}\n\n`);
        res.end();
        return;
      }
      if (req.url.includes(':streamGenerateContent')) {
        seen.gemini.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Saw Gemini img' }] }, finishReason: 'STOP' }] })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  const dataDir = makeTempDir('sp-p4d-');
  const workDir = makeTempDir('sp-p4w-');
  const studio = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1' });
  const studioBase = `http://127.0.0.1:${studio.port}`;

  try {
    const msgWithImage = [{
      role: 'user',
      content: 'Review this reference screenshot',
      hydratedAttachments: [{
        id: 'att_1',
        filename: 'preview.png',
        mimeType: 'image/png',
        base64: TINY_PNG_B64,
      }],
    }];

    // 1. OpenAI-compatible vision request sends image_url
    await streamChat({
      provider: { id: 'oai', name: 'OAI', kind: 'openai-compatible', baseUrl: `${baseUrl}/v1`, effectiveApiKey: 'k', toolMode: 'native' },
      model: 'vision-model',
      systemPrompt: 'Sys',
      messages: msgWithImage,
      tools: [],
    });
    const oaiContent = seen.openai[0].messages.at(-1).content;
    assert.ok(Array.isArray(oaiContent));
    assert.ok(oaiContent.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));

    // 2. OpenAI-compatible text-only model falls back gracefully on 400 image_url unsupported
    const fb = await streamChat({
      provider: { id: 'oai-text', name: 'TextOnly', kind: 'openai-compatible', baseUrl: `${baseUrl}/v1`, effectiveApiKey: 'k', toolMode: 'native' },
      model: 'text-only-ablit',
      systemPrompt: 'Sys',
      messages: msgWithImage,
      tools: [],
    });
    assert.equal(fb.content, 'Saw image');

    // 3. Anthropic sends base64 image block
    await streamChat({
      provider: { id: 'ant', name: 'Claude', kind: 'anthropic', baseUrl, effectiveApiKey: 'k', toolMode: 'native' },
      model: 'claude-sonnet-4-5',
      systemPrompt: 'Sys',
      messages: msgWithImage,
      tools: [],
    });
    const antBlocks = seen.anthropic[0].messages[0].content;
    assert.ok(antBlocks.some((b) => b.type === 'image' && b.source.media_type === 'image/png' && b.source.data === TINY_PNG_B64));

    // 4. Gemini sends inlineData part
    await streamChat({
      provider: { id: 'gem', name: 'Gemini', kind: 'gemini', baseUrl, effectiveApiKey: 'k', toolMode: 'native' },
      model: 'gemini-2.5-pro',
      systemPrompt: 'Sys',
      messages: msgWithImage,
      tools: [],
    });
    const gemParts = seen.gemini[0].contents[0].parts;
    assert.ok(gemParts.some((p) => p.inlineData?.mimeType === 'image/png' && p.inlineData?.data === TINY_PNG_B64));

    // 5. Studio HTTP attachment upload & authenticated download (plus SVG CSP safety)
    const boot = await fetch(`${studioBase}/?token=${studio.token}`);
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie, Origin: studioBase, 'Content-Type': 'application/json' };
    const { session } = await (await fetch(`${studioBase}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Img Test', workspacePath: workDir }),
    })).json();

    const up = await fetch(`${studioBase}/api/sessions/${session.id}/attachments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'plate.png', mimeType: 'image/png', base64Data: TINY_PNG_B64 }),
    });
    assert.equal(up.status, 201);
    const { attachment } = await up.json();
    assert.equal(attachment.mimeType, 'image/png');

    const dl = await fetch(`${studioBase}/api/sessions/${session.id}/attachments/${attachment.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'image/png');

    // SVG attachment served with strict CSP
    const svgUp = await fetch(`${studioBase}/api/sessions/${session.id}/attachments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename: 'ref.svg', mimeType: 'image/svg+xml', base64Data: Buffer.from('<svg></svg>').toString('base64') }),
    });
    assert.equal(svgUp.status, 201);
    const { attachment: svgAtt } = await svgUp.json();
    const svgDl = await fetch(`${studioBase}/api/sessions/${session.id}/attachments/${svgAtt.id}`, {
      headers: { Cookie: cookie },
    });
    assert.match(svgDl.headers.get('content-security-policy') || '', /default-src 'none'/);
  } finally {
    await studio.close();
    await new Promise((r) => srv.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('Resume after hitting maxTurns limit extends budget and continues execution to completion', async () => {
  const base = makeTempDir('sp-resume-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({
      title: 'MaxTurns Resume',
      workspacePath: workDir,
      providerId: 'abliteration',
      model: 'm',
      maxTurns: 2,
      uninterruptedMode: false,
    });
    let coordTurn = 0;
    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          coordTurn++;
          if (coordTurn < 3) {
            return { content: `Turn ${coordTurn}`, reasoning: '', toolCalls: [{ id: `t${coordTurn}`, name: 'list_files', arguments: {} }] };
          }
          return {
            content: 'Finished on turn 3!',
            reasoning: '',
            toolCalls: [{ id: 'tc_done', name: 'report_complete', arguments: { summary: 'Done after resume', verification: 'OK' } }],
          };
        }
        return { content: 'All done!', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    await orch.approveAndRun(session.id, { rules: '- R', plan: '1. Finish' });
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000 && store.getSession(session.id).phase !== 'paused') {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(store.getSession(session.id).phase, 'paused');
    assert.match(store.getSession(session.id).lastError || '', /maxTurns/i);
    assert.equal(coordTurn, 2);

    // Click Resume -> should extend maxTurns and run turn 3 to completion!
    await orch.resumeSession(session.id);
    const wait2 = Date.now();
    while (Date.now() - wait2 < 5000 && store.getSession(session.id).phase !== 'completed') {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(store.getSession(session.id).phase, 'completed');
    assert.equal(coordTurn, 3);
    assert.ok(store.getSession(session.id).maxTurns > 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
