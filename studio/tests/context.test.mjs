import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveModelContextProfile,
  resolveContextBudget,
  assessContextAlignment,
  buildOverflowLadder,
  buildPromptWindow,
  buildDeterministicMemoryDelta,
  mergeWorkingMemory,
} from '../lib/context.mjs';
import { createStore } from '../lib/store.mjs';
import { createOrchestrator } from '../lib/orchestrator.mjs';
import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills');

function makeTempDir(prefix = 'sp-ctx-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveModelContextProfile & resolveContextBudget adapt sweet-spot window by provider/model and session override', () => {
  const groq = resolveContextBudget({
    session: { contextMode: 'auto' },
    provider: { id: 'groq', kind: 'openai-compatible' },
    model: 'openai/gpt-oss-120b',
  });
  assert.equal(groq.maxChars, 24_000);
  assert.equal(groq.maxTokens, 6_000);
  assert.equal(groq.tpmLimitTokens, 12_000);

  const gemma4 = resolveContextBudget({
    session: { contextMode: 'auto' },
    provider: { id: 'gemini', kind: 'gemini' },
    model: 'gemma-4-31b-it',
  });
  assert.equal(gemma4.maxChars, 24_000);
  assert.equal(gemma4.maxTokens, 6_000);
  assert.equal(gemma4.tpmLimitTokens, 15_000);

  // assessContextAlignment catches TPM & context-size misalignments immediately
  const gemmaMisaligned = assessContextAlignment({
    provider: { id: 'gemini', kind: 'gemini' },
    model: 'gemma-4-31b-it',
    contextMode: 'large',
    systemTokens: 5_000,
    totalHistoryTokens: 40_000,
    hasWorkingMemory: false,
  });
  assert.equal(gemmaMisaligned.severity, 'error');
  assert.ok(gemmaMisaligned.warnings.some((w) => /15K input tokens\/min/i.test(w.message)));

  const ollamaMisaligned = assessContextAlignment({
    provider: { id: 'ollama', kind: 'openai-compatible' },
    model: 'qwen3:8b',
    contextMode: 'large',
    systemTokens: 4_000,
    totalHistoryTokens: 5_000,
    hasWorkingMemory: false,
  });
  assert.equal(ollamaMisaligned.severity, 'error');
  assert.ok(ollamaMisaligned.warnings.some((w) => /exceeds this model's typical/i.test(w.message)));

  const cleanAlign = assessContextAlignment({
    provider: { id: 'gemini', kind: 'gemini' },
    model: 'gemini-4-hydrogen',
    contextMode: 'auto',
    systemTokens: 5_000,
    totalHistoryTokens: 12_000,
    hasWorkingMemory: false,
  });
  assert.equal(cleanAlign.severity, 'ok');
  assert.equal(cleanAlign.warnings.length, 0);

  const ollamaSmall = resolveContextBudget({
    session: { contextMode: 'auto' },
    provider: { id: 'ollama', kind: 'openai-compatible' },
    model: 'qwen3:8b',
  });
  assert.equal(ollamaSmall.maxChars, 32_000);

  const ollamaBig = resolveContextBudget({
    session: { contextMode: 'auto' },
    provider: { id: 'ollama', kind: 'openai-compatible' },
    model: 'qwen3:32b',
  });
  assert.equal(ollamaBig.maxChars, 48_000);

  const orFree = resolveContextBudget({
    session: { contextMode: 'auto' },
    provider: { id: 'openrouter', kind: 'openai-compatible' },
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  });
  assert.equal(orFree.maxChars, 80_000);

  const claude = resolveContextBudget({
    session: { contextMode: 'auto' },
    provider: { id: 'anthropic', kind: 'anthropic' },
    model: 'claude-sonnet-5-5',
  });
  assert.equal(claude.maxChars, 180_000);

  const gemini = resolveContextBudget({
    session: { contextMode: 'auto' },
    provider: { id: 'gemini', kind: 'gemini' },
    model: 'gemini-4-hydrogen',
  });
  assert.equal(gemini.maxChars, 240_000);
  assert.equal(gemini.maxTokens, 60_000);
  assert.equal(gemini.modelContextTokens, 1_000_000);

  // Explicit session override wins over auto model profile
  const compactOverride = resolveContextBudget({
    session: { contextMode: 'compact' },
    provider: { id: 'gemini', kind: 'gemini' },
    model: 'gemini-4-hydrogen',
  });
  assert.equal(compactOverride.mode, 'compact');
  assert.equal(compactOverride.maxChars, 32_000);

  const largeOverride = resolveContextBudget({
    session: { contextMode: 'large' },
    provider: { id: 'groq', kind: 'openai-compatible' },
    model: 'llama-3.1-8b-instant',
  });
  assert.equal(largeOverride.mode, 'large');
  assert.equal(largeOverride.maxChars, 260_000);

  // Sanity check direct profile helper
  assert.equal(resolveModelContextProfile({ id: 'abliteration', kind: 'openai-compatible' }, 'abliterated-model-large-flash').sweetSpotChars, 240_000);
});

test('buildOverflowLadder produces smooth descending steps down to 16K chars', () => {
  assert.deepEqual(buildOverflowLadder(240_000), [240_000, 132_000, 72_000, 16_000]);
  assert.deepEqual(buildOverflowLadder(32_000), [32_000, 17_600, 16_000]);
  assert.deepEqual(buildOverflowLadder(16_000), [16_000]);
});

test('buildPromptWindow returnMeta captures droppedMessages & deterministic memory delta preserves key facts', () => {
  const msgs = [];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: 'user', content: `Directive #${i}: build component_${i} (${'u'.repeat(300)})` });
    msgs.push({
      role: 'assistant',
      content: `Implemented module_${i} cleanly.`,
      toolCalls: [{ id: `tc_${i}`, name: 'write_file', arguments: { path: `src/mod_${i}.js` } }],
    });
    msgs.push({ role: 'tool', toolCallId: `tc_${i}`, toolName: 'write_file', content: `Wrote src/mod_${i}.js (${'x'.repeat(800)})` });
  }

  const meta = buildPromptWindow(msgs, { maxChars: 4000, returnMeta: true });
  assert.ok(meta.droppedCount > 0, 'expected older turns to drop');
  assert.ok(meta.trimmedToolCount > 0, 'expected large tool outputs to trim');
  assert.equal(meta.messages[0].role, 'user');
  assert.equal(meta.droppedMessages.length, meta.droppedCount);

  const delta = buildDeterministicMemoryDelta(meta.droppedMessages);
  assert.match(delta, /src\/mod_0\.js/);
  assert.match(delta, /Directive #6/);

  const merged = mergeWorkingMemory('## Existing\n- Keep zero dependencies', delta, { maxChars: 12_000 });
  assert.match(merged, /Keep zero dependencies/);
  assert.match(merged, /src\/mod_0\.js/);
});

test('auto-compaction pins Working Memory across model switches and stepped overflow retries cleanly', async () => {
  const dataDir = makeTempDir('sp-ctx-orch-data-');
  const workDir = makeTempDir('sp-ctx-orch-work-');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({
      title: 'Long Context Switch',
      workspacePath: workDir,
      providerId: 'groq', // 32K char sweet spot in auto mode
      model: 'openai/gpt-oss-120b',
      contextMode: 'auto',
    });

    // Seed enough older messages to exceed 32K chars so auto-compaction triggers
    for (let i = 0; i < 16; i++) {
      store.appendMessage(session.id, { role: 'user', content: `Step ${i}: design requirement ${'r'.repeat(1500)}` });
      store.appendMessage(session.id, { role: 'assistant', content: `Completed step ${i} decision: use modular SVG layers. ${'a'.repeat(1500)}` });
    }

    const observedPrompts = [];
    const observedWindowSizes = [];
    let overflowOnce = true;

    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        // Compaction call uses the compactor system prompt
        if (systemPrompt.includes('memory compactor')) {
          return {
            content: '## Decisions & Constraints\n- Use modular SVG layers.\n## Verified Progress\n- Completed steps 0 through 10 cleanly.',
            reasoning: '',
            toolCalls: [],
          };
        }
        observedPrompts.push(systemPrompt);
        observedWindowSizes.push(messages.reduce((sum, m) => sum + String(m.content || '').length, 0));
        if (overflowOnce) {
          overflowOnce = false;
          const err = new Error('maximum context length exceeded');
          err.isContextOverflow = true;
          throw err;
        }
        return { content: 'Got it, continuing with Working Memory intact.', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    await orch.sendUserMessage(session.id, 'Now continue with step 16');

    // Auto-compaction ran and pinned Working Memory into the very same turn's systemPrompt
    const afterGroq = store.getSession(session.id);
    assert.match(afterGroq.workingMemory, /Use modular SVG layers/);
    assert.ok(observedPrompts[0].includes('# Session Working Memory (Auto-Compacted Context)'));
    assert.ok(observedPrompts[0].includes('Use modular SVG layers'));

    // Stepped overflow retry succeeded on second attempt with smaller window
    assert.equal(observedWindowSizes.length, 2);
    assert.ok(observedWindowSizes[1] < observedWindowSizes[0], `expected stepped smaller retry: ${observedWindowSizes[1]} < ${observedWindowSizes[0]}`);

    // Switch session mid-flight to Gemini (60K tok / 240K char sweet spot) -> Working Memory still pinned!
    store.updateSession(session.id, { providerId: 'gemini', model: 'gemini-4-hydrogen' });
    await orch.sendUserMessage(session.id, 'Summarize what we decided earlier');
    const latestPrompt = observedPrompts[observedPrompts.length - 1];
    assert.ok(latestPrompt.includes('Use modular SVG layers'), 'new model must inherit pinned Working Memory');
    const afterGemini = store.getSession(session.id);
    assert.equal(afterGemini.lastContextStats.model, 'gemini-4-hydrogen');
    assert.equal(afterGemini.lastContextStats.budgetTokens, 60_000);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('HTTP API exposes contextOverview, contextMode updates, and POST /api/sessions/:id/compact preserving raw history', async () => {
  const dataDir = makeTempDir('sp-ctx-srv-data-');
  const workDir = makeTempDir('sp-ctx-srv-work-');
  const srv = await createStudioServer({ port: 0, dataDir, defaultWorkspace: workDir, token: 'ctx-test-token' });
  const headers = { Authorization: 'Bearer ctx-test-token', 'Content-Type': 'application/json' };
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const createRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'API Context Session',
        workspacePath: workDir,
        providerId: 'gemini',
        model: 'gemini-4-hydrogen',
        contextMode: 'auto',
      }),
    });
    assert.equal(createRes.status, 201);
    const { session } = await createRes.json();

    // Seed raw messages directly via store
    for (let i = 0; i < 10; i++) {
      srv.store.appendMessage(session.id, { role: 'user', content: `User goal ${i}: verify schema` });
      srv.store.appendMessage(session.id, {
        role: 'assistant',
        content: `Verified module ${i}.`,
        toolCalls: [{ id: `t${i}`, name: 'write_file', arguments: { path: `app/file_${i}.mjs` } }],
      });
    }

    // GET session returns live contextOverview sized to Gemini (60K tok)
    const d1 = await (await fetch(`${base}/api/sessions/${session.id}`, { headers })).json();
    assert.equal(d1.session.contextOverview.budgetTokens, 60_000);
    assert.equal(d1.session.contextOverview.mode, 'auto');

    // Switch model to Groq + test instant budget adaptation & TPM warning on GET
    await fetch(`${base}/api/sessions/${session.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ providerId: 'groq', model: 'openai/gpt-oss-120b' }),
    });
    const d2 = await (await fetch(`${base}/api/sessions/${session.id}`, { headers })).json();
    assert.equal(d2.session.contextOverview.budgetTokens, 6_000);
    assert.equal(d2.session.contextOverview.tpmLimitTokens, 12_000);
    assert.ok(['warn', 'error'].includes(d2.session.contextOverview.alignmentSeverity));

    // Trigger manual compaction endpoint (uses deterministic fallback since no real API key)
    const compactRes = await fetch(`${base}/api/sessions/${session.id}/compact`, {
      method: 'POST',
      headers,
    });
    assert.equal(compactRes.status, 200);
    const compactData = await compactRes.json();
    assert.equal(compactData.ok, true);
    assert.ok(compactData.compactedCount > 0);
    assert.match(compactData.workingMemory, /app\/file_0\.mjs/);

    // Raw messages on disk must remain 100% intact (+1 system notice)
    const rawMsgs = srv.store.getMessages(session.id);
    assert.ok(rawMsgs.length >= 20, 'raw history must never be deleted by compaction');
  } finally {
    await srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
