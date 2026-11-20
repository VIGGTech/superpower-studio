import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-srv-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('HTTP auth cookie, Origin=null CSRF rejection, sandboxed companion CSP, skills & expert roster API', async () => {
  const dataDir = makeTempDir('sp-sdata-');
  const workDir = makeTempDir('sp-swork-');
  initGitRepo(workDir);

  const studio = await createStudioServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    streamChatImpl: async ({ systemPrompt }) => {
      if (systemPrompt.includes('Role: Subordinate')) {
        return { content: 'Subordinate ready.', reasoning: '', toolCalls: [] };
      }
      return {
        content: 'Pausing for review.',
        reasoning: '',
        toolCalls: [{ id: 'tc1', name: 'escalate_to_subordinate', arguments: { question: 'Hold open?' } }],
      };
    },
  });

  const base = `http://127.0.0.1:${studio.port}`;
  try {
    // 1. Unauthenticated API request rejected
    const unauth = await fetch(`${base}/api/sessions`);
    assert.equal(unauth.status, 403);

    // 2. Auth bootstrap via ?token=... sets HttpOnly SameSite=Strict cookie
    const boot = await fetch(`${base}/?token=${studio.token}`, { redirect: 'manual' });
    assert.ok(boot.status === 200 || boot.status === 302);
    const setCookie = boot.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';')[0];

    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };

    // 3. Skills API returns all 23 live skills across both packs & individual skill/reference contents
    const skillsRes = await fetch(`${base}/api/skills`, { headers });
    assert.equal(skillsRes.status, 200);
    const skillsData = await skillsRes.json();
    assert.equal(skillsData.skills.length, 23);
    assert.equal(skillsData.packs.length, 2);

    const tddRes = await fetch(`${base}/api/skills/test-driven-development`, { headers });
    assert.equal(tddRes.status, 200);
    const tddData = await tddRes.json();
    assert.match(tddData.content, /NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST/);

    const secRefRes = await fetch(`${base}/api/skills/security-and-hardening?file=references/security-checklist.md`, { headers });
    assert.equal(secRefRes.status, 200);
    const secRefData = await secRefRes.json();
    assert.match(secRefData.content, /OWASP|Security/i);

    // 4. Expert Roster API returns all 12 seeded experts (incl. medical + quality/security auditors) & supports CRUD
    const expRes = await fetch(`${base}/api/experts`, { headers });
    assert.equal(expRes.status, 200);
    const expData = await expRes.json();
    assert.equal(expData.experts.length, 12);
    assert.ok(expData.experts.some((e) => e.id === 'senior-dicom-engineer'));
    assert.ok(expData.experts.some((e) => e.id === 'hl7-fhir-engineer'));
    assert.ok(expData.experts.some((e) => e.id === 'anatomical-illustrator'));
    assert.ok(expData.experts.some((e) => e.id === 'human-physiology-expert'));
    assert.ok(expData.experts.some((e) => e.id === 'security-auditor'));
    assert.ok(expData.experts.some((e) => e.id === 'web-performance-auditor'));
    assert.ok(expData.experts.some((e) => e.id === 'accessibility-auditor'));
    assert.ok(expData.experts.some((e) => e.id === 'test-engineer'));

    const addExp = await fetch(`${base}/api/experts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'radiology-qa', name: 'Radiology QA', specialty: 'Modality QA' }),
    });
    assert.equal(addExp.status, 201);

    // 5. Providers API masks saved API keys
    const putProv = await fetch(`${base}/api/providers/abliteration`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ apiKey: 'ak_super_secret_1234', defaultModel: 'ablit-70b' }),
    });
    assert.equal(putProv.status, 200);
    const provs = await (await fetch(`${base}/api/providers`, { headers })).json();
    const ablit = provs.providers.find((p) => p.id === 'abliteration');
    assert.equal(ablit.hasKey, true);
    assert.ok(!JSON.stringify(ablit).includes('ak_super_secret_1234'));

    // 6. Create session & pin skills
    const sRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Server Test', workspacePath: workDir, providerId: 'abliteration', model: 'ablit-70b' }),
    });
    assert.equal(sRes.status, 201);
    const { session } = await sRes.json();

    const pinRes = await fetch(`${base}/api/sessions/${session.id}/skills`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ pinnedSkills: ['test-driven-development', 'systematic-debugging'] }),
    });
    assert.equal(pinRes.status, 200);

    // 7. Security Review Focus #1: Origin: null (sandboxed iframe) & foreign Origin CANNOT call approve
    const nullOrigin = await fetch(`${base}/api/sessions/${session.id}/approve`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'null', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: 'hacked' }),
    });
    assert.equal(nullOrigin.status, 403);

    const evilOrigin = await fetch(`${base}/api/sessions/${session.id}/approve`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: 'hacked' }),
    });
    assert.equal(evilOrigin.status, 403);

    // 8. Companion HTML sets frame-ancestors 'self' and uses postMessage bridge
    const compRes = await fetch(`${base}/api/sessions/${session.id}/companion`, { headers: { Cookie: cookie } });
    assert.equal(compRes.status, 200);
    assert.match(compRes.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
    const compHtml = await compRes.text();
    assert.match(compHtml, /superpowers-companion-event/);
    assert.match(compHtml, /postMessage/);

    const evRes = await fetch(`${base}/api/sessions/${session.id}/companion/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'click', choice: 'option-a' }),
    });
    assert.equal(evRes.status, 200);

    // 9. Dirty worktree delete returns 409 without force, succeeds with ?force=true
    const s2Res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Parallel Worktree', workspacePath: workDir, providerId: 'abliteration', model: 'ablit-70b' }),
    });
    const { session: s2 } = await s2Res.json();

    // Mark session 1 paused (active) so session 2 gets an isolated worktree
    await fetch(`${base}/api/sessions/${session.id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rules: '- R1', plan: '1. P1' }),
    });
    await fetch(`${base}/api/sessions/${session.id}/pause`, { method: 'POST', headers });

    const app2 = await fetch(`${base}/api/sessions/${s2.id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rules: '- R2', plan: '1. P2' }),
    });
    assert.equal(app2.status, 200);
    const { session: s2Running } = await app2.json();
    assert.ok(s2Running.worktreeBranch && s2Running.worktreeBranch.startsWith('superpowers/'));
    await fetch(`${base}/api/sessions/${s2.id}/stop`, { method: 'POST', headers });

    fs.writeFileSync(path.join(s2Running.effectiveWorkDir, 'uncommitted.txt'), 'dirty', 'utf8');
    const delBlocked = await fetch(`${base}/api/sessions/${s2.id}`, { method: 'DELETE', headers });
    assert.equal(delBlocked.status, 409);

    const delForced = await fetch(`${base}/api/sessions/${s2.id}?force=true`, { method: 'DELETE', headers });
    assert.equal(delForced.status, 200);
  } finally {
    await studio.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
