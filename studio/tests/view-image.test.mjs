import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { getToolDefinitions, createToolExecutor } from '../lib/tools.mjs';
import { createOrchestrator } from '../lib/orchestrator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

function makeTempDir(prefix = 'sp-vimg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('view_workspace_image is available across all tiers, enforces path scoping, and loads raster/SVG images', async () => {
  for (const cfg of [
    { tier: 'subordinate', phase: 'interview' },
    { tier: 'coordinator', phase: 'running' },
    { tier: 'expert', phase: 'running', readOnly: true, depth: 1 },
  ]) {
    const names = getToolDefinitions(cfg).map((t) => t.name);
    assert.ok(names.includes('view_workspace_image'), `missing view_workspace_image for ${cfg.tier}`);
  }

  const base = makeTempDir('sp-vi1-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(workDir, 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'outputs', 'preview.png'), TINY_PNG);
  fs.writeFileSync(path.join(base, 'secret.png'), TINY_PNG);
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'ViewImg', workspacePath: workDir });
    const exec = createToolExecutor({
      store,
      skillsRoot: SKILLS_ROOT,
      session,
      effectiveWorkDir: workDir,
      allowedTools: new Set(['view_workspace_image']),
    });

    const okRes = await exec.execute('view_workspace_image', { path: 'outputs/preview.png' });
    assert.equal(okRes.ok, true);
    assert.ok(okRes.imageAttachment);
    assert.equal(okRes.imageAttachment.mimeType, 'image/png');

    // Path traversal blocked
    const esc = await exec.execute('view_workspace_image', { path: '../secret.png' });
    assert.equal(esc.ok, false);
    assert.match(esc.output, /outside workspace/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('Coordinator and Experts receive hydrated multimodal image pixels on the next turn after calling view_workspace_image', async () => {
  const base = makeTempDir('sp-vi2-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(workDir, 'gallery'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'gallery', 'plate.png'), TINY_PNG);
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'Vision Loop', workspacePath: workDir, providerId: 'gemini', model: 'gemini-2.5-pro' });

    let expertTurn = 0;
    let expertSawPixels = false;
    let coordTurn = 0;

    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          coordTurn++;
          if (coordTurn === 1) {
            return {
              content: 'Inspecting rendered plate via Human Physiology Expert',
              reasoning: '',
              toolCalls: [{ id: 'tc_e', name: 'spawn_expert', arguments: { expertId: 'human-physiology-expert', task: 'Inspect gallery/plate.png' } }],
            };
          }
          return {
            content: 'Verified.',
            reasoning: '',
            toolCalls: [
              { id: 'tc_p1', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
              { id: 'tc_done', name: 'report_complete', arguments: { summary: 'Inspected plate visually', verification: 'OK' } },
            ],
          };
        }
        if (systemPrompt.includes('Human Physiology Expert')) {
          expertTurn++;
          if (expertTurn === 1) {
            return {
              content: 'Viewing image...',
              reasoning: '',
              toolCalls: [{ id: 'tc_v', name: 'view_workspace_image', arguments: { path: 'gallery/plate.png' } }],
            };
          }
          // Turn 2 must receive hydrated image pixels!
          const imgMsg = messages.find((m) => m.role === 'user' && Array.isArray(m.hydratedAttachments) && m.hydratedAttachments.length > 0);
          if (imgMsg && imgMsg.hydratedAttachments[0].mimeType === 'image/png' && imgMsg.hydratedAttachments[0].base64) {
            expertSawPixels = true;
          }
          return { content: 'Anatomy verified visually.', reasoning: '', toolCalls: [] };
        }
        return { content: 'Done!', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    await orch.approveAndRun(session.id, { rules: '- Check anatomy visually', plan: '1. Inspect plate' });
    const start = Date.now();
    while (Date.now() - start < 5000 && store.getSession(session.id).phase !== 'completed') {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(expertSawPixels, true, 'Expert must receive hydrated PNG base64 pixels after view_workspace_image');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('hydrateMessages caps raster images per request to <=3 newest, retries on stricter provider image limits, and resumeSession recovers failed sessions', async () => {
  const base = makeTempDir('sp-imgcap-');
  const workDir = path.join(base, 'work');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const store = createStore({ dataDir });
    const session = store.createSession({
      title: 'Image Cap Recovery',
      workspacePath: workDir,
      providerId: 'abliteration',
      model: 'm-vision',
      uninterruptedMode: true,
    });

    // Save 6 raster PNG attachments and put them in Coordinator message history
    const coordMsgs = [];
    for (let i = 1; i <= 6; i++) {
      const att = store.saveAttachment(session.id, {
        filename: `plate-${i}.png`,
        mimeType: 'image/png',
        base64Data: TINY_PNG.toString('base64'),
      });
      coordMsgs.push({ role: 'user', content: `Inspect plate ${i}`, attachments: [att] });
      coordMsgs.push({ role: 'assistant', content: `Reviewed plate ${i}` });
    }
    coordMsgs.push({ role: 'user', content: 'Finish final task now.' });

    store.updateSession(session.id, {
      phase: 'failed',
      lastError: 'This request has more images than the limit of 4. Send fewer images and try again.',
      rules: '- Finish cleanly',
      plan: '1. Complete final verification',
      tasks: [{ id: 'task-1', title: 'Complete final verification', status: 'in_progress' }],
    });
    store.saveCoordinator(session.id, {
      status: 'failed',
      turnCount: 10,
      lastError: 'This request has more images than the limit of 4.',
      messages: coordMsgs,
    });

    const observedImageCounts = [];
    let observedFilenamesOnFirstCall = [];
    const orch = createOrchestrator({
      store,
      skillsRoot: SKILLS_ROOT,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          const allRaster = messages.flatMap((m) =>
            (m.hydratedAttachments || []).filter((a) => a.base64)
          );
          observedImageCounts.push(allRaster.length);
          if (observedImageCounts.length === 1) {
            observedFilenamesOnFirstCall = allRaster.map((a) => a.filename);
            // Simulate an even stricter provider rejecting >1 image on first try!
            if (allRaster.length > 1) {
              throw Object.assign(new Error('This request has more images than the limit of 1. Send fewer images and try again.'), { status: 400 });
            }
          }
          return {
            content: 'Completed after image cap!',
            reasoning: '',
            toolCalls: [
              { id: 'tc_p1', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
              { id: 'tc_f1', name: 'report_complete', arguments: { summary: 'Done cleanly', verification: 'OK' } },
            ],
          };
        }
        return { content: 'All done!', reasoning: '', toolCalls: [] };
      },
      emitEvent: () => {},
    });

    // Resume directly from FAILED state!
    await orch.resumeSession(session.id);
    const start = Date.now();
    while (Date.now() - start < 5000 && store.getSession(session.id).phase !== 'completed') {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(store.getSession(session.id).phase, 'completed');
    assert.ok(observedImageCounts[0] <= 3, `Expected first call to cap raster images to <=3, got ${observedImageCounts[0]}`);
    assert.deepEqual(observedFilenamesOnFirstCall, ['plate-4.png', 'plate-5.png', 'plate-6.png'], 'Must keep only the 3 newest images');
    assert.ok(observedImageCounts.length >= 2 && observedImageCounts[1] <= 1, `Expected automatic retry with <=1 image, got counts ${JSON.stringify(observedImageCounts)}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
