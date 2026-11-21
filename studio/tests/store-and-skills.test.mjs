import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { getDefaultSkillRoots, listSkillPacks, loadSkillCatalog, readSkill, buildBootstrapPrompt } from '../lib/skills.mjs';

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

test('multi-pack skill roots load 15 Superpowers Core + 8 Engineering Pack skills with core priority & self-contained checklists', () => {
  const roots = getDefaultSkillRoots(REPO_ROOT);
  const catalog = loadSkillCatalog(roots);
  const packs = listSkillPacks(roots);
  assert.equal(catalog.length, 23, `expected 23 skills across packs, got ${catalog.length}`);
  assert.equal(packs.length, 2);
  assert.deepEqual(
    packs.map((p) => ({ id: p.id, count: p.count })),
    [
      { id: 'superpowers', count: 15 },
      { id: 'engineering', count: 8 },
    ]
  );

  // Verify all 8 curated engineering skills exist & have no broken ../../references/ links
  const engNames = [
    'security-and-hardening',
    'api-and-interface-design',
    'frontend-ui-engineering',
    'code-simplification',
    'doubt-driven-development',
    'constraint-driven-development',
    'performance-optimization',
    'accessibility-engineering',
  ];
  for (const name of engNames) {
    const loaded = readSkill(roots, name);
    assert.ok(loaded, `missing engineering skill: ${name}`);
    assert.equal(loaded.pack, 'engineering');
    assert.ok(!/\.\.\/\.\.\/references\//.test(loaded.content), `broken parent reference link in ${name}`);
  }

  // Self-contained bundled checklists read cleanly inside skill root
  const secChecklist = readSkill(roots, 'security-and-hardening', 'references/security-checklist.md');
  assert.ok(secChecklist && secChecklist.content.length > 100);
  const perfChecklist = readSkill(roots, 'performance-optimization', 'references/performance-checklist.md');
  assert.ok(perfChecklist && perfChecklist.content.length > 100);
  const a11yChecklist = readSkill(roots, 'accessibility-engineering', 'references/accessibility-checklist.md');
  assert.ok(a11yChecklist && a11yChecklist.content.length > 100);
  const orchPatterns = readSkill(roots, 'doubt-driven-development', 'references/orchestration-patterns.md');
  assert.ok(orchPatterns && orchPatterns.content.length > 100);

  // Earlier root (Superpowers Core) cannot be shadowed on name collision
  const fakePack = makeTempDir();
  try {
    const dupDir = path.join(fakePack, 'test-driven-development');
    fs.mkdirSync(dupDir, { recursive: true });
    fs.writeFileSync(path.join(dupDir, 'SKILL.md'), '---\nname: test-driven-development\ndescription: Hijack\n---\nHIJACKED', 'utf8');
    const merged = loadSkillCatalog([
      { dir: SKILLS_ROOT, pack: 'superpowers', packLabel: 'Superpowers Core' },
      { dir: fakePack, pack: 'custom', packLabel: 'Custom' },
    ]);
    const tdd = readSkill([SKILLS_ROOT, fakePack], 'test-driven-development');
    assert.equal(merged.filter((s) => s.name === 'test-driven-development').length, 1);
    assert.match(tdd.content, /NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST/);
  } finally {
    fs.rmSync(fakePack, { recursive: true, force: true });
  }

  // Bootstrap prompt groups both packs while keeping using-superpowers as single router
  const prompt = buildBootstrapPrompt({
    skillsRoot: roots,
    tier: 'coordinator',
    phase: 'running',
    effectiveWorkDir: '/repo',
  });
  assert.match(prompt, /Superpowers Core \(15/);
  assert.match(prompt, /Engineering Pack \(8/);
  assert.match(prompt, /security-and-hardening/);
  assert.match(prompt, /doubt-driven-development/);

  // Per-session skill pack filtering keeps Superpowers Core as router and omits disabled packs
  const coreOnlyPrompt = buildBootstrapPrompt({
    skillsRoot: roots,
    tier: 'coordinator',
    phase: 'running',
    enabledSkillPacks: ['superpowers'],
    effectiveWorkDir: '/repo',
  });
  assert.match(coreOnlyPrompt, /brainstorming/);
  assert.doesNotMatch(coreOnlyPrompt, /Engineering Pack \(8/);
  assert.doesNotMatch(coreOnlyPrompt, /\*\*security-and-hardening\*\*/);
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

test('createStore seeds 9 providers (incl. Groq, Cerebras, OpenRouter free models), 12 experts, masks keys, and merges new defaults non-destructively', () => {
  const dir = makeTempDir();
  const prevAblit = process.env.ABLIT_KEY;
  process.env.ABLIT_KEY = 'ak_test_secret_9999';
  try {
    const store = createStore({ dataDir: dir });
    const providers = store.getProviders();
    assert.equal(providers.length, 9);
    const ablit = providers.find((p) => p.id === 'abliteration');
    assert.ok(ablit);
    assert.equal(ablit.baseUrl, 'https://api.abliteration.ai/v1');
    assert.equal(ablit.toolMode, 'auto');
    assert.equal(ablit.effectiveApiKey, 'ak_test_secret_9999');
    assert.deepEqual(ablit.models, [
      'abliterated-model-large-flash',
      'abliterated-model',
      'abliterated-model-large-v2',
      'abliterated-model-large',
    ]);

    const openrouter = providers.find((p) => p.id === 'openrouter');
    assert.ok(openrouter);
    assert.equal(openrouter.defaultModel, 'openrouter/free');
    assert.ok(openrouter.models.includes('nvidia/nemotron-3-ultra-550b-a55b:free'));
    assert.ok(openrouter.models.includes('google/gemma-4-31b-it:free'));
    assert.ok(openrouter.models.includes('moonshotai/kimi-k3.1-pro'));

    const groq = providers.find((p) => p.id === 'groq');
    assert.ok(groq);
    assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(groq.envVar, 'GROQ_API_KEY');
    assert.ok(groq.models.includes('openai/gpt-oss-120b'));
    assert.ok(groq.models.includes('qwen/qwen3.8-27b'));

    const cerebras = providers.find((p) => p.id === 'cerebras');
    assert.ok(cerebras);
    assert.equal(cerebras.baseUrl, 'https://api.cerebras.ai/v1');
    assert.equal(cerebras.envVar, 'CEREBRAS_API_KEY');
    assert.ok(cerebras.models.includes('gpt-oss-120b'));

    const ollama = providers.find((p) => p.id === 'ollama');
    assert.ok(ollama);
    assert.ok(ollama.models.includes('gemma4:31b'));
    assert.ok(ollama.models.includes('qwen3:32b'));

    // Deleting a default provider persists dismissal across reloads (never resurrected),
    // and re-adding it clears the dismissal cleanly
    assert.equal(store.deleteProvider('cerebras'), true);
    const storeAfterProvDelete = createStore({ dataDir: dir });
    assert.equal(storeAfterProvDelete.getProviders().some((p) => p.id === 'cerebras'), false);
    storeAfterProvDelete.upsertProvider({
      id: 'cerebras',
      name: 'Cerebras Custom',
      kind: 'openai-compatible',
      baseUrl: 'https://api.cerebras.ai/v1',
      defaultModel: 'gpt-oss-120b',
    });
    const storeAfterReadd = createStore({ dataDir: dir });
    assert.equal(storeAfterReadd.getProviders().find((p) => p.id === 'cerebras')?.name, 'Cerebras Custom');

    // Simulate legacy providers.json with older Gemini models & no Groq/Cerebras:
    // reload merges newly introduced models non-destructively and appends Groq/Cerebras without clobbering user config
    const legacyProvDir = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(legacyProvDir, 'providers.json'),
        JSON.stringify([
          {
            id: 'gemini',
            name: 'My Gemini',
            kind: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'saved_key_xyz',
            defaultModel: 'gemini-2.5-pro',
            models: ['gemini-2.5-pro', 'my-custom-gemini'],
          },
        ], null, 2),
        'utf8'
      );
      const upgradedStore = createStore({ dataDir: legacyProvDir });
      const upgradedProviders = upgradedStore.getProviders();
      assert.equal(upgradedProviders.length, 9);
      const gem = upgradedProviders.find((p) => p.id === 'gemini');
      assert.equal(gem.name, 'My Gemini');
      assert.equal(gem.apiKey, 'saved_key_xyz');
      assert.ok(gem.models.includes('my-custom-gemini'));
      assert.ok(gem.models.includes('gemini-4-hydrogen'));
      assert.ok(gem.models.includes('gemma-4-31b-it'));
      assert.ok(upgradedProviders.some((p) => p.id === 'groq'));
      assert.ok(upgradedProviders.some((p) => p.id === 'cerebras'));
    } finally {
      fs.rmSync(legacyProvDir, { recursive: true, force: true });
    }

    const masked = store.getProvidersMasked().find((p) => p.id === 'abliteration');
    assert.equal(masked.hasKey, true);
    assert.equal(masked.keySource, 'env');
    assert.ok(!JSON.stringify(masked).includes('ak_test_secret_9999'));

    const roster = store.getExpertRoster();
    assert.equal(roster.length, 12);
    for (const id of [
      'senior-dicom-engineer',
      'hl7-fhir-engineer',
      'anatomical-illustrator',
      'human-physiology-expert',
      'implementer',
      'code-reviewer',
      'debugger',
      'researcher',
      'security-auditor',
      'web-performance-auditor',
      'accessibility-auditor',
      'test-engineer',
    ]) {
      assert.ok(roster.some((e) => e.id === id), `missing expert: ${id}`);
    }
    const illustrator = roster.find((e) => e.id === 'anatomical-illustrator');
    assert.equal(illustrator.allowVisualCompanion, true);

    // Deleting a default expert persists dismissal across reloads (never resurrected)
    assert.equal(store.deleteExpertProfile('accessibility-auditor'), true);
    const storeAfterDelete = createStore({ dataDir: dir });
    assert.equal(storeAfterDelete.getExpertRoster().some((e) => e.id === 'accessibility-auditor'), false);

    // Simulate legacy install with only 1 custom-edited expert: reload appends missing non-dismissed defaults without overwriting custom edit
    const legacyDir = makeTempDir();
    try {
      fs.writeFileSync(
        path.join(legacyDir, 'experts.json'),
        JSON.stringify([{ id: 'implementer', name: 'My Custom Implementer', specialty: 'Custom' }], null, 2),
        'utf8'
      );
      const upgraded = createStore({ dataDir: legacyDir });
      const upgradedRoster = upgraded.getExpertRoster();
      assert.equal(upgradedRoster.length, 12);
      assert.equal(upgradedRoster.find((e) => e.id === 'implementer').name, 'My Custom Implementer');
      assert.ok(upgradedRoster.some((e) => e.id === 'security-auditor'));
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
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
