import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { buildBootstrapPrompt } from '../lib/skills.mjs';
import { getToolDefinitions } from '../lib/tools.mjs';
import { createOrchestrator } from '../lib/orchestrator.mjs';
import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-qa-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Subordinate prompt separates interview vs running phases and exposes offer_actions tool', () => {
  const subTools = getToolDefinitions({ tier: 'subordinate', phase: 'interview' }).map((t) => t.name);
  assert.ok(subTools.includes('offer_actions'));

  const subRunningTools = getToolDefinitions({ tier: 'subordinate', phase: 'running' }).map((t) => t.name);
  assert.ok(subRunningTools.includes('offer_actions'));

  const runningPrompt = buildBootstrapPrompt({
    skillsRoot: SKILLS_ROOT,
    tier: 'subordinate',
    phase: 'running',
    rules: '- Rule 1',
    plan: '1. Step 1',
  });
  assert.match(runningPrompt, /do NOT tell your human partner to click Approve & Dispatch/i);
  assert.match(runningPrompt, /offer_actions/);
});

test('offer_actions persists suggestedActions on session and direct POST /api/sessions/:id/relay delivers directives to Coordinator', async () => {
  const base = makeTempDir('sp-qa2-');
  const dataDir = path.join(base, 'data');
  const workDir = path.join(base, 'work');

  let releaseCoord;
  const gate = new Promise((r) => { releaseCoord = r; });
  let releaseFollowUp;
  const followUpGate = new Promise((r) => { releaseFollowUp = r; });
  let coordSawRelayed = false;
  let coordTurn = 0;

  const studio = await createStudioServer({
    dataDir,
    skillsRoot: SKILLS_ROOT,
    port: 0,
    host: '127.0.0.1',
    streamChatImpl: async ({ systemPrompt, messages }) => {
      if (systemPrompt.includes('Role: Subordinate')) {
        const lastRole = messages[messages.length - 1]?.role;
        if (lastRole === 'tool') {
          return { content: 'Pick an option below!', reasoning: '', toolCalls: [] };
        }
        return {
          content: 'Which approach?',
          reasoning: '',
          toolCalls: [{
            id: 'tc_act',
            name: 'offer_actions',
            arguments: {
              actions: [
                { label: 'Proceed with Approach 1', kind: 'reply', value: 'Proceed with Approach 1', style: 'primary' },
                { label: 'Approve & Dispatch', kind: 'approve', style: 'success' },
              ],
            },
          }],
        };
      }
      if (systemPrompt.includes('Role: Coordinator')) {
        coordTurn++;
        if (coordTurn === 1) {
          await gate;
          return { content: 'Working', reasoning: '', toolCalls: [{ id: 'tc_l', name: 'list_files', arguments: {} }] };
        }
        if (messages.some((m) => String(m.content || '').includes('Use high-contrast color palette'))) {
          coordSawRelayed = true;
        }
        if (coordTurn >= 3) {
          await followUpGate;
          return {
            content: 'Follow-up done',
            reasoning: '',
            toolCalls: [
              { id: 'tc_p2', name: 'update_task_progress', arguments: { taskId: 'task-2', status: 'done' } },
              { id: 'tc_fin2', name: 'report_complete', arguments: { summary: 'Follow-up done', verification: 'OK' } },
            ],
          };
        }
        return {
          content: 'Done',
          reasoning: '',
          toolCalls: [
            { id: 'tc_p1', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
            { id: 'tc_fin', name: 'report_complete', arguments: { summary: 'Done', verification: 'OK' } },
          ],
        };
      }
      return { content: 'ok', reasoning: '', toolCalls: [] };
    },
  });

  const baseUrl = `http://127.0.0.1:${studio.port}`;
  try {
    const boot = await fetch(`${baseUrl}/?token=${studio.token}`);
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' };

    // Verify quick-actions bar exists in index.html
    const html = await boot.text();
    assert.match(html, /id="quick-actions-bar"/);

    const { session } = await (await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'QA Test', workspacePath: workDir, providerId: 'abliteration', model: 'm' }),
    })).json();

    // Interview message -> Subordinate calls offer_actions
    const msgRes = await fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'Help me choose an approach' }),
    });
    assert.equal(msgRes.status, 200);
    const detail1 = await (await fetch(`${baseUrl}/api/sessions/${session.id}`, { headers })).json();
    assert.equal(detail1.session.suggestedActions.length, 2);
    assert.equal(detail1.session.suggestedActions[0].label, 'Proceed with Approach 1');

    // Approve & dispatch -> clears interview suggestedActions
    await fetch(`${baseUrl}/api/sessions/${session.id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rules: '- R', plan: '1. Task A' }),
    });

    // Direct one-click Relay endpoint while Coordinator is running
    const relayRes = await fetch(`${baseUrl}/api/sessions/${session.id}/relay`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ instructions: 'Use high-contrast color palette', priority: 'urgent' }),
    });
    assert.equal(relayRes.status, 200);
    releaseCoord();

    const start = Date.now();
    while (Date.now() - start < 5000 && studio.store.getSession(session.id).phase !== 'completed') {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(coordSawRelayed, true);

    // Follow-up relay after all tasks are done appends a new in_progress task so ETA is positive (not 0s)
    const beforeTasks = studio.store.getSession(session.id).tasks;
    studio.store.updateSession(session.id, {
      tasks: beforeTasks.map((t) => ({ ...t, status: 'done', durationMs: 60_000 })),
    });
    const followUpRes = await fetch(`${baseUrl}/api/sessions/${session.id}/relay`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ instructions: 'Refine SVG proportions using clinical reference', priority: 'normal' }),
    });
    assert.equal(followUpRes.status, 200);
    const followUpDetail = await (await fetch(`${baseUrl}/api/sessions/${session.id}`, { headers })).json();
    assert.equal(followUpDetail.session.tasks.length, beforeTasks.length + 1);
    const added = followUpDetail.session.tasks[followUpDetail.session.tasks.length - 1];
    assert.equal(added.status, 'in_progress');
    assert.match(added.title, /Follow-up: Refine SVG proportions/i);
    assert.ok(followUpDetail.session.missionSummary.etaSeconds > 0, 'Follow-up ETA should be > 0s');
    releaseFollowUp();
    await fetch(`${baseUrl}/api/sessions/${session.id}/stop`, { method: 'POST', headers });
  } finally {
    await studio.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
