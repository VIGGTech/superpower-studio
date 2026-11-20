import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { createOrchestrator } from '../lib/orchestrator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-unint-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for condition');
}

test('uninterruptedMode (default true) runs past maxTurns without pausing and enforces 100% task completion gate', async () => {
  const base = makeTempDir('sp-u1-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({
      title: 'Run To 100%',
      workspacePath: workDir,
      providerId: 'abliteration',
      model: 'm',
      maxTurns: 2, // Would normally pause at turn 2, but uninterruptedMode defaults to true!
    });
    assert.equal(session.uninterruptedMode, true);

    let coordTurn = 0;
    let prematureRejected = false;
    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          coordTurn++;
          if (coordTurn === 1) {
            return {
              content: 'Finishing task 1',
              reasoning: '',
              toolCalls: [{ id: 't1', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } }],
            };
          }
          if (coordTurn === 2) {
            // Try completing early while task-2 is still pending!
            return {
              content: 'Trying early complete',
              reasoning: '',
              toolCalls: [{ id: 't2', name: 'report_complete', arguments: { summary: 'Half done', verification: 'OK' } }],
            };
          }
          if (coordTurn === 3) {
            // Verify gate rejected premature report_complete AND did NOT pause at maxTurns=2!
            const lastTool = messages[messages.length - 1];
            if (lastTool?.role === 'tool' && /incomplete tasks/i.test(lastTool.content)) {
              prematureRejected = true;
            }
            return {
              content: 'Completing task 2 now',
              reasoning: '',
              toolCalls: [
                { id: 't3', name: 'update_task_progress', arguments: { taskId: 'task-2', status: 'done' } },
                { id: 't4', name: 'report_complete', arguments: { summary: '100% done', verification: 'All 2 tasks verified' } },
              ],
            };
          }
        }
        return { content: 'All 100% done!', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    await orch.approveAndRun(session.id, {
      rules: '- Finish everything',
      plan: '### Task 1: First\n### Task 2: Second',
    });

    await waitFor(() => store.getSession(session.id).phase === 'completed', 5000);
    assert.equal(prematureRejected, true, 'report_complete must be rejected while tasks remain incomplete');
    assert.equal(coordTurn, 3, 'Coordinator must continue past maxTurns=2 without pausing');
    assert.ok(store.getSession(session.id).tasks.every((t) => t.status === 'done'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Subordinate watchdog automatically recovers a stalled Coordinator in uninterruptedMode without human intervention', async () => {
  const base = makeTempDir('sp-u2-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({
      title: 'Watchdog Recovery',
      workspacePath: workDir,
      providerId: 'abliteration',
      model: 'm',
      uninterruptedMode: true,
    });

    let coordCalls = 0;
    let watchdogRelayed = false;
    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          coordCalls++;
          // Simulate 3 text-only stalled turns first
          if (coordCalls <= 3) {
            return { content: `Stalled narration ${coordCalls}`, reasoning: '', toolCalls: [] };
          }
          // After Subordinate watchdog nudges us, finish task and complete!
          return {
            content: 'Recovered and finishing!',
            reasoning: '',
            toolCalls: [
              { id: 't_done1', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
              { id: 't_done2', name: 'report_complete', arguments: { summary: 'Recovered & done', verification: 'OK' } },
            ],
          };
        }
        if (systemPrompt.includes('Role: Subordinate')) {
          const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
          const lastRole = messages[messages.length - 1]?.role;
          if (lastUser.includes('stalled') && lastRole !== 'tool') {
            watchdogRelayed = true;
            return {
              content: 'Nudging Coordinator to continue',
              reasoning: '',
              toolCalls: [{ id: 'tc_wd', name: 'relay_to_coordinator', arguments: { instructions: 'Stop narrating and finish task-1 with tools now.', priority: 'urgent' } }],
            };
          }
          return { content: 'Supervisor handled recovery.', reasoning: '', toolCalls: [] };
        }
        return { content: 'ok', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    await orch.approveAndRun(session.id, { rules: '- R', plan: '### Task 1: Complete work' });
    await waitFor(() => store.getSession(session.id).phase === 'completed', 5000);
    assert.equal(watchdogRelayed, true, 'Subordinate watchdog should auto-relay recovery instructions');
    assert.equal(coordCalls, 4);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Subordinate anti-polling guard prevents repeated get_coordinator_status loops in one turn', async () => {
  const base = makeTempDir('sp-u3-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'AntiPoll', workspacePath: workDir, providerId: 'abliteration', model: 'm' });
    store.updateSession(session.id, { phase: 'paused' });

    let subCalls = 0;
    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Subordinate')) {
          subCalls++;
          // Simulate model trying to call get_coordinator_status over and over
          if (subCalls <= 5) {
            return {
              content: '',
              reasoning: '',
              toolCalls: [{ id: `st_${subCalls}`, name: 'get_coordinator_status', arguments: {} }],
            };
          }
          return { content: 'Status reported.', reasoning: '', toolCalls: [] };
        }
        return { content: 'ok', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    await orch.sendUserMessage(session.id, 'How is it going?');
    assert.ok(subCalls <= 2, `Expected Subordinate to stop polling quickly, but called ${subCalls} times`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Subordinate always delivers a final user-facing synthesis reply if tool-step budget is exhausted', async () => {
  const base = makeTempDir('sp-subcap-');
  const dataDir = path.join(base, 'data');
  const workDir = path.join(base, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, 'notes.txt'), 'hello world\n', 'utf8');
  try {
    const store = createStore({ dataDir });
    store.upsertProvider({
      id: 'abliteration',
      name: 'Abliteration.ai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.abliteration.ai/v1',
      apiKey: 'ak_mock',
      defaultModel: 'm',
    });
    const session = store.createSession({ title: 'DeepInspect', workspacePath: workDir, providerId: 'abliteration', model: 'm' });

    let finalToolFreeCalled = false;
    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ tools }) => {
        if (!tools || tools.length === 0) {
          finalToolFreeCalled = true;
          return { content: 'Here is the complete plan based on all inspected files.', reasoning: '', toolCalls: [] };
        }
        return {
          content: '',
          reasoning: '',
          toolCalls: [{ id: `ls_${Math.random().toString(36).slice(2, 7)}`, name: 'list_files', arguments: {} }],
        };
      },
      emitEvent: () => {},
    });

    await orch.sendUserMessage(session.id, 'Inspect everything and write the plan');
    assert.equal(finalToolFreeCalled, true, 'Expected guaranteed tool-free synthesis turn after exhausting tool budget');
    const msgs = store.getMessages(session.id);
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, 'assistant');
    assert.match(last.content, /complete plan/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Frontend app.js initializes top-level event wiring cleanly without ReferenceError / TDZ crashes', () => {
  const appJsPath = path.resolve(__dirname, '..', 'public', 'app.js');
  const code = fs.readFileSync(appJsPath, 'utf8');
  const makeEl = () => ({
    classList: { add() {}, remove() {}, toggle() { return false; } },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return makeEl(); },
    appendChild() {},
    remove() {},
    focus() {},
    click() {},
    reset() {},
    style: {},
    dataset: {},
    elements: {},
  });
  let bootstrapped = false;
  const elementsBySel = new Map();
  const getOrMakeEl = (sel) => {
    if (!elementsBySel.has(sel)) {
      const el = makeEl();
      el.innerHTML = '';
      elementsBySel.set(sel, el);
    }
    return elementsBySel.get(sel);
  };
  const ctx = {
    document: { querySelector: getOrMakeEl, querySelectorAll: () => [], createElement: makeEl, activeElement: null },
    window: { location: { protocol: 'http:', host: 'localhost:49500', search: '', pathname: '/' }, history: { replaceState() {} }, addEventListener() {} },
    location: { protocol: 'http:', host: 'localhost:49500', search: '', pathname: '/' },
    WebSocket: class { addEventListener() {} },
    fetch: async () => {
      bootstrapped = true;
      return { ok: true, json: async () => ({ providers: [], experts: [], skills: [], sessions: [] }) };
    },
    setInterval: () => 1,
    setTimeout: () => 1,
    clearTimeout: () => {},
    FormData: class { entries() { return []; } },
    FileReader: class {},
    console, Date, Math, JSON, Array, Object, Set, Map, Promise, Number, String, Boolean, RegExp, Error, encodeURIComponent,
  };
  vm.runInNewContext(code, ctx);
  assert.equal(bootstrapped, true, 'app.js should reach bootstrap() cleanly');

  // Verify renderAgentsAndMissionTab auto-collapses completed Experts & Done tasks and preserves open state
  vm.runInContext(`
    state.activeDetail = {
      session: {
        id: 's1', phase: 'running', providerId: 'abliteration', model: 'm1',
        tasks: [
          { id: 'task-1', title: 'Done Task', status: 'done', durationMs: 5000 },
          { id: 'task-2', title: 'Active Task', status: 'in_progress' },
          { id: 'task-3', title: 'Queued Task', status: 'pending' },
        ],
      },
      coordinator: { status: 'running', turnCount: 5, messages: [], directives: [] },
      experts: [
        { id: 'e1', role: 'Anatomical Illustrator', status: 'completed', model: 'm1', task: 'Build diagram SVG' },
        { id: 'e2', role: 'Software Implementer', status: 'running', model: 'm1', task: 'Run validator', currentTool: 'run_command' },
      ],
    };
    renderAgentsAndMissionTab();
  `, ctx);
  const htmlCollapsed = elementsBySel.get('#coord-inspector').innerHTML;
  assert.match(htmlCollapsed, /Software Implementer/);
  assert.match(htmlCollapsed, /data-ui-toggle="showCompletedExperts"\s*>/);
  assert.match(htmlCollapsed, /Completed Experts \(1\)/);
  assert.match(htmlCollapsed, /data-ui-toggle="showDoneTasks"\s*>/);
  assert.match(htmlCollapsed, /Done Tasks \(1\)/);

  // Opening a drawer persists across re-renders
  vm.runInContext(`
    state.ui.showCompletedExperts = true;
    state.ui.showDoneTasks = true;
    renderAgentsAndMissionTab();
  `, ctx);
  const htmlOpen = elementsBySel.get('#coord-inspector').innerHTML;
  assert.match(htmlOpen, /data-ui-toggle="showCompletedExperts"\s+open>/);
  assert.match(htmlOpen, /data-ui-toggle="showDoneTasks"\s+open>/);
});
