import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { loadSkillCatalog, readSkill, buildBootstrapPrompt } from '../lib/skills.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sp-studio-test-'));
}

test('loadSkillCatalog discovers all 15 live Superpowers skills with frontmatter', () => {
  const catalog = loadSkillCatalog(SKILLS_ROOT);
  assert.equal(catalog.length, 15, `expected 15 skills, got ${catalog.length}`);
  const names = catalog.map((s) => s.name);
  for (const required of [
    'brainstorming',
    'diagnosing-superpowers',
    'dispatching-parallel-agents',
    'executing-plans',
    'finishing-a-development-branch',
    'receiving-code-review',
    'requesting-code-review',
    'subagent-driven-development',
    'systematic-debugging',
    'test-driven-development',
    'using-git-worktrees',
    'using-superpowers',
    'verification-before-completion',
    'writing-plans',
    'writing-skills',
  ]) {
    assert.ok(names.includes(required), `missing skill: ${required}`);
  }
  for (const skill of catalog) {
    assert.ok(skill.description && skill.description.length > 5, `empty description for ${skill.name}`);
  }
});

test('readSkill reads SKILL.md, supporting files, and blocks path traversal', () => {
  const tdd = readSkill(SKILLS_ROOT, 'test-driven-development');
  assert.ok(tdd);
  assert.equal(tdd.name, 'test-driven-development');
  assert.match(tdd.content, /NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST/);

  const support = readSkill(SKILLS_ROOT, 'brainstorming', 'visual-companion.md');
  assert.ok(support);
  assert.match(support.content, /Visual Companion/);

  assert.throws(() => readSkill(SKILLS_ROOT, 'brainstorming', '../../package.json'), /outside skill/i);
  assert.equal(readSkill(SKILLS_ROOT, 'does-not-exist'), null);
});

test('buildBootstrapPrompt adapts by tier, includes all 15 skills, pins rules/plan & pinned skills', () => {
  const subPrompt = buildBootstrapPrompt({
    skillsRoot: SKILLS_ROOT,
    tier: 'subordinate',
    phase: 'interview',
    rules: 'Never use external deps.',
    plan: '1. Build core',
    pinnedSkills: ['test-driven-development'],
    shellName: 'Git Bash',
    effectiveWorkDir: '/repo',
  });
  assert.match(subPrompt, /Subordinate/i);
  assert.match(subPrompt, /brainstorming/);
  assert.match(subPrompt, /systematic-debugging/);
  assert.match(subPrompt, /verification-before-completion/);
  assert.match(subPrompt, /NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST/);
  assert.match(subPrompt, /Never use external deps\./);
  assert.match(subPrompt, /propose_rules/);

  const coordPrompt = buildBootstrapPrompt({
    skillsRoot: SKILLS_ROOT,
    tier: 'coordinator',
    phase: 'running',
    rules: 'Never use external deps.',
    plan: '1. Build core',
    pinnedSkills: [],
    shellName: 'Git Bash',
    effectiveWorkDir: '/repo',
    expertRoster: [
      { id: 'senior-dicom-engineer', name: 'Senior DICOM Engineer', specialty: 'DICOM PS3.x' },
    ],
  });
  assert.match(coordPrompt, /Coordinator/i);
  assert.match(coordPrompt, /spawn_expert/);
  assert.match(coordPrompt, /senior-dicom-engineer/);
  assert.match(coordPrompt, /report_complete/);
});

test('createStore seeds 7 providers, 8 experts (incl. 4 medical experts), masks keys, and resolves env vars', () => {
  const dir = makeTempDir();
  const prevAblit = process.env.ABLIT_KEY;
  process.env.ABLIT_KEY = 'ak_test_secret_9999';
  try {
    const store = createStore({ dataDir: dir });
    const providers = store.getProviders();
    assert.equal(providers.length, 7);
    const ablit = providers.find((p) => p.id === 'abliteration');
    assert.ok(ablit);
    assert.equal(ablit.baseUrl, 'https://api.abliteration.ai/v1');
    assert.equal(ablit.toolMode, 'auto');
    assert.equal(ablit.effectiveApiKey, 'ak_test_secret_9999');

    const masked = store.getProvidersMasked().find((p) => p.id === 'abliteration');
    assert.equal(masked.hasKey, true);
    assert.equal(masked.keySource, 'env');
    assert.ok(!JSON.stringify(masked).includes('ak_test_secret_9999'));

    const roster = store.getExpertRoster();
    assert.equal(roster.length, 8);
    for (const id of [
      'senior-dicom-engineer',
      'hl7-fhir-engineer',
      'anatomical-illustrator',
      'human-physiology-expert',
      'implementer',
      'code-reviewer',
      'debugger',
      'researcher',
    ]) {
      assert.ok(roster.some((e) => e.id === id), `missing expert: ${id}`);
    }
    const illustrator = roster.find((e) => e.id === 'anatomical-illustrator');
    assert.equal(illustrator.allowVisualCompanion, true);
  } finally {
    if (prevAblit === undefined) delete process.env.ABLIT_KEY;
    else process.env.ABLIT_KEY = prevAblit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store persists sessions, messages, coordinator, experts, screens, events, and reconciles on startup', () => {
  const dir = makeTempDir();
  try {
    const store1 = createStore({ dataDir: dir });
    const session = store1.createSession({
      title: 'DICOM Viewer',
      workspacePath: dir,
      providerId: 'abliteration',
      model: 'abliterated-model',
    });
    store1.appendMessage(session.id, { role: 'user', content: 'Build a viewer' });
    store1.updateSession(session.id, { phase: 'running', rules: 'Rule 1' });
    store1.saveCoordinator(session.id, {
      status: 'running',
      turnCount: 3,
      directives: ['Start plan'],
      messages: [{ role: 'user', content: 'Mission' }],
    });
    store1.saveExpert(session.id, {
      id: 'exp-1',
      expertId: 'senior-dicom-engineer',
      role: 'Senior DICOM Engineer',
      status: 'running',
      model: 'abliterated-model',
      messages: [],
    });
    store1.writeScreen(session.id, '01-layout.html', '<h2>Mockup</h2>');
    store1.appendCompanionEvent(session.id, { type: 'click', choice: 'a' });

    // Reload from disk and reconcile
    const store2 = createStore({ dataDir: dir });
    const rec = store2.reconcileOnStartup();
    assert.deepEqual(rec.pausedSessions, [session.id]);
    assert.deepEqual(rec.stoppedExperts, ['exp-1']);

    const reloaded = store2.getSession(session.id);
    assert.equal(reloaded.phase, 'paused');
    const coord = store2.getCoordinator(session.id);
    assert.equal(coord.status, 'paused');
    const exp = store2.getExpert(session.id, 'exp-1');
    assert.equal(exp.status, 'stopped');

    const msgs = store2.getMessages(session.id);
    assert.equal(msgs.length, 2); // original user message + restart notice
    assert.equal(store2.getLatestScreen(session.id).filename, '01-layout.html');
    assert.equal(store2.getCompanionEvents(session.id).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
