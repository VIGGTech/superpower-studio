import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { createOrchestrator, buildPromptWindow } from '../lib/orchestrator.mjs';
import { getDefaultSkillRoots } from '../lib/skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-orch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting for condition');
}

test('3-tier Subordinate -> Coordinator -> parallel Experts flow completes and reports back', async () => {
  const workDir = makeTempDir('sp-work-');
  const dataDir = makeTempDir('sp-data-');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({
      title: 'DICOM + FHIR Integration',
      workspacePath: workDir,
      providerId: 'abliteration',
      model: 'sub-model',
      coordinatorProviderId: 'anthropic',
      coordinatorModel: 'coord-model',
      expertProviderId: 'deepseek',
      expertModel: 'exp-model',
    });

    const events = [];
    const seenModels = [];
    let coordTurn = 0;

    const fakeStreamChat = async ({ model, systemPrompt, messages, onText }) => {
      seenModels.push({ model, isSub: systemPrompt.includes('Role: Subordinate'), isCoord: systemPrompt.includes('Role: Coordinator'), isExp: systemPrompt.includes('Specialist Expert') });

      if (systemPrompt.includes('Role: Subordinate')) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
        const hasToolResult = messages[messages.length - 1]?.role === 'tool';
        if (hasToolResult) {
          onText?.('Rules drafted. Ready for approval.');
          return { content: 'Rules drafted. Ready for approval.', reasoning: '', toolCalls: [] };
        }
        if (lastUser.includes('Coordinator reported completion')) {
          onText?.('Mission accomplished! Both DICOM and FHIR modules are ready.');
          return { content: 'Mission accomplished! Both DICOM and FHIR modules are ready.', reasoning: '', toolCalls: [] };
        }
        return {
          content: 'Drafting rules and plan...',
          reasoning: '',
          toolCalls: [{
            id: 'tc_rules',
            name: 'propose_rules',
            arguments: { rulesMarkdown: '- Enforce DICOM PS3.x\n- Enforce FHIR R4', planMarkdown: '1. Build DICOM & FHIR helpers' },
          }],
        };
      }

      if (systemPrompt.includes('Role: Coordinator')) {
        coordTurn++;
        if (coordTurn === 1) {
          return {
            content: 'Dispatching DICOM and HL7/FHIR experts in parallel.',
            reasoning: '',
            toolCalls: [
              { id: 'tc_e1', name: 'spawn_expert', arguments: { expertId: 'senior-dicom-engineer', task: 'Create dicom.txt' } },
              { id: 'tc_e2', name: 'spawn_expert', arguments: { expertId: 'hl7-fhir-engineer', task: 'Create fhir.txt' } },
            ],
          };
        }
        return {
          content: 'Both experts succeeded.',
          reasoning: '',
          toolCalls: [
            { id: 'tc_prog', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
            {
              id: 'tc_done',
              name: 'report_complete',
              arguments: { summary: 'Created dicom.txt and fhir.txt', verification: 'Files verified on disk' },
            },
          ],
        };
      }

      // Expert turn
      const hasTool = messages[messages.length - 1]?.role === 'tool';
      if (hasTool) {
        return { content: 'Expert work complete.', reasoning: '', toolCalls: [] };
      }
      assert.match(systemPrompt, /Enforce DICOM PS3\.x/);
      const isDicom = systemPrompt.includes('Senior DICOM Engineer');
      return {
        content: isDicom ? 'Writing DICOM file' : 'Writing FHIR file',
        reasoning: '',
        toolCalls: [{
          id: isDicom ? 'tc_w1' : 'tc_w2',
          name: 'write_file',
          arguments: { path: isDicom ? 'dicom.txt' : 'fhir.txt', content: isDicom ? 'PS3.10' : 'FHIR R4' },
        }],
      };
    };

    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: fakeStreamChat,
      emitEvent: (ev) => events.push(ev),
    });

    // 1. Interview with Subordinate
    await orch.sendUserMessage(session.id, 'Build a DICOM and FHIR parser');
    assert.equal(store.getSession(session.id).phase, 'ready');
    assert.match(store.getSession(session.id).rules, /Enforce DICOM PS3\.x/);

    // 2. Approve & dispatch to Coordinator -> parallel Experts -> complete
    await orch.approveAndRun(session.id);
    await waitFor(() => store.getSession(session.id).phase === 'completed', 5000);

    assert.equal(fs.readFileSync(path.join(workDir, 'dicom.txt'), 'utf8'), 'PS3.10');
    assert.equal(fs.readFileSync(path.join(workDir, 'fhir.txt'), 'utf8'), 'FHIR R4');

    const experts = store.listExperts(session.id);
    assert.equal(experts.length, 2);
    assert.ok(experts.every((e) => e.status === 'completed'));

    // Verify per-tier model routing
    assert.ok(seenModels.some((m) => m.isSub && m.model === 'sub-model'));
    assert.ok(seenModels.some((m) => m.isCoord && m.model === 'coord-model'));
    assert.ok(seenModels.some((m) => m.isExp && m.model === 'exp-model'));

    // Subordinate summarized completion to human
    const subMsgs = store.getMessages(session.id);
    assert.ok(subMsgs.some((m) => m.role === 'assistant' && m.content.includes('Mission accomplished')));
    assert.ok(events.some((e) => e.type === 'coordinator_event'));
    assert.ok(events.some((e) => e.type === 'expert_event'));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Subordinate stays responsive mid-run and relays directives cleanly at Coordinator turn boundary', async () => {
  const workDir = makeTempDir('sp-work2-');
  const dataDir = makeTempDir('sp-data2-');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'Live Relay', workspacePath: workDir, providerId: 'abliteration', model: 'm1' });

    let releaseSlowTurn;
    const slowTurnGate = new Promise((r) => { releaseSlowTurn = r; });
    let coordTurn = 0;
    let sawRelayedDirective = false;

    const fakeStreamChat = async ({ systemPrompt, messages }) => {
      if (systemPrompt.includes('Role: Subordinate')) {
        const lastRole = messages[messages.length - 1]?.role;
        if (lastRole === 'tool') {
          return { content: 'Relayed your update to the Coordinator!', reasoning: '', toolCalls: [] };
        }
        return {
          content: 'Relaying to Coordinator...',
          reasoning: '',
          toolCalls: [
            { id: 'tc_st', name: 'get_coordinator_status', arguments: {} },
            { id: 'tc_rel', name: 'relay_to_coordinator', arguments: { instructions: 'Use dark theme palette' } },
          ],
        };
      }
      if (systemPrompt.includes('Role: Coordinator')) {
        coordTurn++;
        if (coordTurn === 1) {
          await slowTurnGate;
          return {
            content: 'Checking workspace...',
            reasoning: '',
            toolCalls: [{ id: 'tc_lf', name: 'list_files', arguments: {} }],
          };
        }
        // Check that relayed directive appeared cleanly AFTER tool_result
        const toolIdx = messages.findIndex((m) => m.role === 'tool');
        const steerIdx = messages.findIndex((m) => m.role === 'user' && String(m.content).includes('Use dark theme palette'));
        if (toolIdx !== -1 && steerIdx > toolIdx) sawRelayedDirective = true;
        return {
          content: 'Done with dark theme.',
          reasoning: '',
          toolCalls: [
            { id: 'tc_p1', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
            { id: 'tc_rc', name: 'report_complete', arguments: { summary: 'Done', verification: 'OK' } },
          ],
        };
      }
      return { content: 'ok', reasoning: '', toolCalls: [] };
    };

    const orch = createOrchestrator({ store, skillsRoot: SKILLS_ROOT, streamChatImpl: fakeStreamChat, emitEvent: () => {} });
    await orch.approveAndRun(session.id, { rules: '- Rule A', plan: '1. Do work' });

    // While Coordinator is paused inside slowTurnGate, chat with Subordinate!
    await orch.sendUserMessage(session.id, 'Please tell Coordinator to use dark theme palette');
    releaseSlowTurn();

    await waitFor(() => store.getSession(session.id).phase === 'completed', 5000);
    assert.equal(sawRelayedDirective, true);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Coordinator handles escalation, text-only nudges (3rd pauses), and context window trimming', async () => {
  const workDir = makeTempDir('sp-work3-');
  const dataDir = makeTempDir('sp-data3-');
  try {
    // 1. Context window trimming
    const bigMessages = [
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'Reading', toolCalls: [{ id: '1', name: 'read_file', arguments: {} }] },
      { role: 'tool', toolCallId: '1', toolName: 'read_file', content: 'A'.repeat(25000) },
      { role: 'assistant', content: 'Still working' },
      { role: 'user', content: 'Latest note' },
    ];
    const trimmed = buildPromptWindow(bigMessages, { maxChars: 5000 });
    assert.ok(trimmed.some((m) => m.role === 'tool' && m.content.includes('[trimmed earlier tool output')));
    assert.ok(trimmed.some((m) => m.content === 'Latest note'));

    // 2. Text-only nudges -> pauses on 3rd consecutive text-only turn in capped mode
    const store = createStore({ dataDir });
    const s1 = store.createSession({ title: 'Chatty', workspacePath: workDir, providerId: 'abliteration', model: 'm1', uninterruptedMode: false });
    let chattyTurns = 0;
    const orch1 = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          chattyTurns++;
          return { content: `Just narrating step ${chattyTurns}`, reasoning: '', toolCalls: [] };
        }
        return { content: 'Noted.', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });
    await orch1.approveAndRun(s1.id, { rules: '- R', plan: 'P' });
    await waitFor(() => store.getSession(s1.id).phase === 'paused', 5000);
    assert.equal(chattyTurns, 3);

    // 3. Escalation pauses immediately and alerts Subordinate
    const s2 = store.createSession({ title: 'Escalate', workspacePath: workDir, providerId: 'abliteration', model: 'm1' });
    let subSawEscalation = false;
    const orch2 = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          return {
            content: 'Need human clarification',
            reasoning: '',
            toolCalls: [{ id: 'tc_esc', name: 'escalate_to_subordinate', arguments: { question: 'Use R4 or R5?', context: 'FHIR version' } }],
          };
        }
        if (messages.some((m) => String(m.content).includes('Use R4 or R5?'))) subSawEscalation = true;
        return { content: 'Coordinator asks: Use R4 or R5?', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });
    await assert.rejects(
      () => orch2.approveAndRun(s2.id, { rules: '- R', plan: 'P' }),
      (err) => err.code === 'WORKSPACE_CONFLICT'
    );
    await orch2.approveAndRun(s2.id, { rules: '- R', plan: 'P', allowSharedNonGit: true });
    await waitFor(() => store.getSession(s2.id).phase === 'paused' && subSawEscalation, 5000);
    assert.equal(subSawEscalation, true);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('per-session enabledExpertIds & enabledSkillPacks scope Coordinator roster, block disabled experts, and auto-load expert defaultSkills', async () => {
  const dataDir = makeTempDir('sp-scope-data-');
  const workDir = makeTempDir('sp-scope-work-');
  try {
    const store = createStore({ dataDir });
    store.upsertProvider({
      id: 'abliteration',
      name: 'Abliteration.ai',
      kind: 'openai-compatible',
      baseUrl: 'https://api.abliteration.ai/v1',
      apiKey: 'ak_mock',
      defaultModel: 'm1',
    });

    const session = store.createSession({
      title: 'Web Security Session',
      workspacePath: workDir,
      providerId: 'abliteration',
      model: 'm1',
      enabledExpertIds: ['implementer', 'security-auditor'],
      enabledSkillPacks: ['superpowers'], // engineering pack disabled at session level
    });

    assert.deepEqual(session.enabledExpertIds, ['implementer', 'security-auditor']);
    assert.deepEqual(session.enabledSkillPacks, ['superpowers']);

    let coordPrompt = '';
    let secExpertPrompt = '';
    let blockedToolMsg = '';
    let coordTurn = 0;

    const orch = createOrchestrator({
      store,
      skillsRoot: getDefaultSkillRoots(REPO_ROOT),
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          coordPrompt = systemPrompt;
          coordTurn++;
          if (coordTurn === 1) {
            // Try spawning both a disabled expert (senior-dicom-engineer) and an enabled one (security-auditor)
            return {
              content: 'Testing roster scoping',
              reasoning: '',
              toolCalls: [
                { id: 'tc_blocked', name: 'spawn_expert', arguments: { expertId: 'senior-dicom-engineer', task: 'Should be blocked' } },
                { id: 'tc_allowed', name: 'spawn_expert', arguments: { expertId: 'security-auditor', task: 'Audit auth flow' } },
              ],
            };
          }
          const toolMsgs = messages.filter((m) => m.role === 'tool').map((m) => String(m.content || ''));
          blockedToolMsg = toolMsgs.find((t) => t.includes('Expert spawn blocked')) || '';
          return {
            content: 'Finishing up',
            reasoning: '',
            toolCalls: [
              { id: 'tc_done', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
              { id: 'tc_rep', name: 'report_complete', arguments: { summary: 'Audit complete', verification: 'Checked' } },
            ],
          };
        }
        if (systemPrompt.includes('Role: Security Auditor')) {
          secExpertPrompt = systemPrompt;
          return { content: 'Security audit complete: 0 critical issues.', reasoning: '', toolCalls: [] };
        }
        return { content: 'Subordinate ack', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    await orch.approveAndRun(session.id, { rules: '- Stay focused', plan: '### Task 1: Run security audit' });
    await waitFor(() => store.getSession(session.id).phase === 'completed', 6000);

    // 1. Coordinator prompt only lists enabled experts and omits disabled medical experts
    assert.match(coordPrompt, /security-auditor/);
    assert.match(coordPrompt, /implementer/);
    assert.doesNotMatch(coordPrompt, /senior-dicom-engineer/);
    assert.doesNotMatch(coordPrompt, /anatomical-illustrator/);

    // 2. Session disabled engineering pack in global catalog, keeping superpowers core
    assert.doesNotMatch(coordPrompt, /Engineering Pack \(8/);

    // 3. Attempting to spawn a disabled expert was blocked cleanly
    assert.match(blockedToolMsg, /Expert spawn blocked.*senior-dicom-engineer/i);

    // 4. Spawned Security Auditor auto-loaded its defaultSkill (security-and-hardening)
    assert.match(secExpertPrompt, /# Active Skill: security-and-hardening/);
    assert.match(secExpertPrompt, /STRIDE/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
