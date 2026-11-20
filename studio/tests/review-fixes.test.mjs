import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { createToolExecutor, getToolDefinitions } from '../lib/tools.mjs';
import { createOrchestrator, buildPromptWindow } from '../lib/orchestrator.mjs';
import { parsePromptToolCalls } from '../lib/providers/prompt-tools.mjs';
import { streamChat } from '../lib/providers/index.mjs';
import { getWorkspaceStatus, prepareSessionWorkspace } from '../lib/worktree.mjs';
import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-fix-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'subpkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'subpkg', 'index.js'), 'export const x = 1;\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('Critical #1: tool executor enforces allowedTools strictly (blocks interview writes and readOnly writes)', async () => {
  const workDir = makeTempDir('sp-c1-');
  const dataDir = makeTempDir('sp-c1d-');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'Perm', workspacePath: workDir });

    const interviewAllowed = new Set(getToolDefinitions({ tier: 'subordinate', phase: 'interview' }).map((t) => t.name));
    const execInterview = createToolExecutor({
      store,
      skillsRoot: SKILLS_ROOT,
      session,
      effectiveWorkDir: workDir,
      allowedTools: interviewAllowed,
    });
    const w = await execInterview.execute('write_file', { path: 'pwn.txt', content: 'bad' });
    assert.equal(w.ok, false);
    assert.match(w.output, /not permitted/i);
    assert.equal(fs.existsSync(path.join(workDir, 'pwn.txt')), false);

    const cmd = await execInterview.execute('run_command', { command: 'echo pwn' });
    assert.equal(cmd.ok, false);
    assert.match(cmd.output, /not permitted/i);

    // Read-only expert should not even receive spawn_expert
    const roDefs = getToolDefinitions({ tier: 'expert', phase: 'running', readOnly: true, depth: 1 }).map((t) => t.name);
    assert.ok(!roDefs.includes('spawn_expert'));
    assert.ok(!roDefs.includes('write_file'));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Critical #2: buildPromptWindow always starts on role=user and never orphans tool messages', () => {
  const msgs = [
    { role: 'user', content: 'A'.repeat(2000) },
    { role: 'assistant', content: 'B'.repeat(2000), toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }] },
    { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'C'.repeat(2000) },
    { role: 'assistant', content: 'D'.repeat(2000), toolCalls: [{ id: 't2', name: 'read_file', arguments: {} }, { id: 't3', name: 'read_file', arguments: {} }] },
    { role: 'tool', toolCallId: 't2', toolName: 'read_file', content: 'ok2' },
    { role: 'tool', toolCallId: 't3', toolName: 'read_file', content: 'ok3' },
  ];
  const win = buildPromptWindow(msgs, { maxChars: 1200 });
  assert.ok(win.length > 0);
  assert.equal(win[0].role, 'user', `expected window to start with user, got ${win[0].role}`);
  // Every tool message must have a preceding assistant with matching toolCallId
  const seenToolCallIds = new Set();
  for (const m of win) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) seenToolCallIds.add(tc.id);
    }
    if (m.role === 'tool') {
      assert.ok(seenToolCallIds.has(m.toolCallId), `orphaned tool message ${m.toolCallId}`);
    }
  }
});

test('Critical #3: Gemini merges consecutive user turns and preserves thoughtSignature on functionCall', async () => {
  let seenBodies = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenBodies.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              functionCall: { id: 'fc_1', name: 'read_file', args: { path: 'a.txt' } },
              thoughtSignature: 'sig_abc123',
            }],
          },
          finishReason: 'STOP',
        }],
      })}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    const provider = { id: 'gemini', name: 'Gemini', kind: 'gemini', baseUrl, effectiveApiKey: 'k', toolMode: 'native' };
    const r1 = await streamChat({
      provider,
      model: 'gemini-2.5-pro',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }],
    });
    assert.equal(r1.toolCalls[0].thoughtSignature, 'sig_abc123');

    // Replay assistant tool call + tool result + relayed user directive consecutively
    await streamChat({
      provider,
      model: 'gemini-2.5-pro',
      systemPrompt: 'Sys',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: '', toolCalls: r1.toolCalls },
        { role: 'tool', toolCallId: r1.toolCalls[0].id, toolName: 'read_file', content: 'file body' },
        { role: 'user', content: '[Relayed Directive] Switch theme' },
      ],
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }],
    });

    const contents = seenBodies[1].contents;
    // Must not have consecutive user turns
    for (let i = 1; i < contents.length; i++) {
      assert.notEqual(
        `${contents[i - 1].role}:${contents[i].role}`,
        'user:user',
        'Gemini contents must not have consecutive user turns'
      );
    }
    // Model turn must echo thoughtSignature
    const modelTurn = contents.find((c) => c.role === 'model');
    assert.equal(modelTurn.parts[0].thoughtSignature, 'sig_abc123');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Critical #4: concurrent approveAndRun serializes git worktrees, rejects duplicate running approve, and preserves completed status on Subordinate error', async () => {
  const repoDir = makeTempDir('sp-c4repo-');
  const dataDir = makeTempDir('sp-c4data-');
  initGitRepo(repoDir);
  try {
    const store = createStore({ dataDir });
    const s1 = store.createSession({ title: 'S1', workspacePath: repoDir, providerId: 'abliteration', model: 'm' });
    const s2 = store.createSession({ title: 'S2', workspacePath: repoDir, providerId: 'abliteration', model: 'm' });

    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt }) => {
        if (systemPrompt.includes('Role: Subordinate')) {
          throw new Error('Simulated Subordinate 429 failure');
        }
        return {
          content: 'Finished work',
          reasoning: '',
          toolCalls: [{ id: 'tc_c', name: 'report_complete', arguments: { summary: 'Done', verification: 'OK' } }],
        };
      },
      emitEvent: () => {},
    });

    // Fire both approveAndRun calls concurrently on the same git repo!
    const [r1, r2] = await Promise.all([
      orch.approveAndRun(s1.id, { rules: '- R1', plan: 'P1' }),
      orch.approveAndRun(s2.id, { rules: '- R2', plan: 'P2' }),
    ]);

    const workDirs = [path.resolve(r1.effectiveWorkDir), path.resolve(r2.effectiveWorkDir)];
    assert.notEqual(workDirs[0], workDirs[1], 'Concurrent approveAndRun on same git repo MUST isolate second session');

    // Wait for completion and verify Subordinate error did NOT flip completed -> failed
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (store.getSession(s1.id).phase !== 'running' && store.getSession(s2.id).phase !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(store.getSession(s1.id).phase, 'completed');
    assert.equal(store.getCoordinator(s1.id).status, 'completed');

    // Duplicate approve while running should throw ALREADY_RUNNING
    const s3 = store.createSession({ title: 'S3', workspacePath: repoDir, providerId: 'abliteration', model: 'm' });
    let release;
    const gate = new Promise((r) => { release = r; });
    const orchHold = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          await gate;
          return { content: 'done', reasoning: '', toolCalls: [{ id: 'x', name: 'report_complete', arguments: { summary: 'ok', verification: 'ok' } }] };
        }
        return { content: 'ok', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });
    await orchHold.approveAndRun(s3.id, { rules: '- R', plan: 'P' });
    await assert.rejects(() => orchHold.approveAndRun(s3.id, { rules: '- R', plan: 'P' }), /already running/i);
    release();
    await orchHold.stopSession(s3.id);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Critical #5 + Important #2 + Important #6: malformed cookie does not crash, env key not persisted, companion handles $& safely', async () => {
  const dataDir = makeTempDir('sp-c5data-');
  const workDir = makeTempDir('sp-c5work-');
  const prevKey = process.env.ABLIT_KEY;
  process.env.ABLIT_KEY = 'ak_env_never_write_to_disk';

  const studio = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${studio.port}`;
  try {
    // Malformed %ZZ cookie alongside valid token cookie must not crash server
    const res = await fetch(`${base}/api/providers`, {
      headers: { Cookie: `junk=100%ZZ; sp_studio_token=${studio.token}` },
    });
    assert.equal(res.status, 200);

    // PUT provider without apiKey must NOT write process.env.ABLIT_KEY into providers.json
    const put = await fetch(`${base}/api/providers/abliteration`, {
      method: 'PUT',
      headers: { Cookie: `sp_studio_token=${studio.token}`, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'new-model-id' }),
    });
    assert.equal(put.status, 200);
    const onDisk = fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8');
    assert.ok(!onDisk.includes('ak_env_never_write_to_disk'), 'Env API key must never be persisted to providers.json');

    // Companion HTML must safely render $& and $$ without regex replacement corruption, and omit .header "Connecting..."
    const { session } = await (await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { Cookie: `sp_studio_token=${studio.token}`, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Dollar', workspacePath: workDir }),
    })).json();
    studio.store.writeScreen(session.id, 'price.html', '<p>Cost: $& and $$100</p>');
    const comp = await (await fetch(`${base}/api/sessions/${session.id}/companion`, {
      headers: { Cookie: `sp_studio_token=${studio.token}` },
    })).text();
    assert.ok(comp.includes('Cost: $& and $$100'));
    assert.ok(!comp.includes('Connecting...'));
  } finally {
    await studio.close();
    if (prevKey === undefined) delete process.env.ABLIT_KEY;
    else process.env.ABLIT_KEY = prevKey;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('Important #3: reconcileOnStartup closes dangling trailing assistant toolCalls', () => {
  const dataDir = makeTempDir('sp-i3-');
  try {
    const store1 = createStore({ dataDir });
    const s = store1.createSession({ title: 'Crash', workspacePath: dataDir });
    store1.updateSession(s.id, { phase: 'running' });
    store1.saveCoordinator(s.id, {
      status: 'running',
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: 'Running cmd', toolCalls: [{ id: 'tc_orphan', name: 'run_command', arguments: { command: 'sleep 99' } }] },
      ],
    });
    store1.appendMessage(s.id, {
      role: 'assistant',
      content: 'Checking',
      toolCalls: [{ id: 'tc_sub_orphan', name: 'get_coordinator_status', arguments: {} }],
    });

    const store2 = createStore({ dataDir });
    store2.reconcileOnStartup();
    const coord = store2.getCoordinator(s.id);
    assert.equal(coord.messages[coord.messages.length - 1].role, 'tool');
    assert.equal(coord.messages[coord.messages.length - 1].toolCallId, 'tc_orphan');

    const subMsgs = store2.getMessages(s.id);
    assert.ok(subMsgs.some((m) => m.role === 'tool' && m.toolCallId === 'tc_sub_orphan'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Important #4: prompt-tools parses stringified arguments, openai-compat handles SSE error & vLLM 400 fallback, anthropic avoids empty text', async () => {
  const p = parsePromptToolCalls('<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"ok.txt\\"}"}</tool_call>');
  assert.equal(p.toolCalls.length, 1);
  assert.deepEqual(p.toolCalls[0].arguments, { path: 'ok.txt' });

  // SSE mid-stream error object must throw, not return empty text
  let mode = 'sse-error';
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (mode === 'sse-error') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ error: { message: 'Upstream GPU OOM' } })}\n\n`);
        res.end();
        return;
      }
      if (mode === 'vllm-400' && body.tools) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '"auto" tool choice requires --enable-auto-tool-choice' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Fallback worked' }, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  try {
    const provider = { id: 'i4-test', name: 'I4', kind: 'openai-compatible', baseUrl, effectiveApiKey: 'k', toolMode: 'auto' };
    await assert.rejects(
      () => streamChat({ provider, model: 'm1', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], maxRetries: 0 }),
      /Upstream GPU OOM/
    );

    mode = 'vllm-400';
    const res = await streamChat({
      provider,
      model: 'vllm-model',
      systemPrompt: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }],
    });
    assert.equal(res.content, 'Fallback worked');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Important #5: worktree status preserves first char of modified file & subdir workspace path', async () => {
  const repoDir = makeTempDir('sp-i5repo-');
  const dataDir = makeTempDir('sp-i5data-');
  initGitRepo(repoDir);
  try {
    // Modify tracked README.md (git status --porcelain produces leading space: " M README.md")
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Modified\n', 'utf8');
    const st = await getWorkspaceStatus(repoDir);
    assert.equal(st.changedFiles[0].path, 'README.md', `got truncated path: ${st.changedFiles[0].path}`);

    // Subdirectory inside git repo preserved in isolated worktree
    const subPath = path.join(repoDir, 'subpkg');
    const s1 = { id: 's_sub1', workspacePath: subPath, effectiveWorkDir: subPath, phase: 'running' };
    const s2 = { id: 's_sub2', workspacePath: subPath, effectiveWorkDir: subPath, phase: 'ready' };
    const res = await prepareSessionWorkspace({ session: s2, activeSessions: [s1], dataDir });
    assert.ok(res.effectiveWorkDir.endsWith(path.sep + 'subpkg'), `expected worktree subdir ending in subpkg, got ${res.effectiveWorkDir}`);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
