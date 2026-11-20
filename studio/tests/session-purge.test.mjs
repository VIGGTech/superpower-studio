import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStudioServer } from '../server.mjs';
import { prepareSessionWorkspace, cleanupSessionWorktree, assessWorkspacePurgeSafety } from '../lib/worktree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-purge-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initTempGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('assessWorkspacePurgeSafety protects home dir, repoRoot, dataDir, and workspaces shared with another session', () => {
  const base = makeTempDir('sp-safe-');
  const repoRoot = path.join(base, 'repo');
  const dataDir = path.join(repoRoot, '.superpowers-studio');
  const dedicated = path.join(base, 'dedicated-project');
  const shared = path.join(base, 'shared-project');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(dedicated, { recursive: true });
  fs.mkdirSync(shared, { recursive: true });

  try {
    assert.equal(
      assessWorkspacePurgeSafety({ session: { id: 's1', workspacePath: os.homedir() }, allSessions: [], repoRoot, dataDir }).canDeleteWorkspace,
      false
    );
    assert.equal(
      assessWorkspacePurgeSafety({ session: { id: 's1', workspacePath: repoRoot }, allSessions: [], repoRoot, dataDir }).canDeleteWorkspace,
      false
    );
    assert.equal(
      assessWorkspacePurgeSafety({ session: { id: 's1', workspacePath: base }, allSessions: [], repoRoot, dataDir }).canDeleteWorkspace,
      false,
      'Parent of repoRoot must be protected'
    );
    assert.equal(
      assessWorkspacePurgeSafety({
        session: { id: 's1', workspacePath: shared },
        allSessions: [{ id: 's1', workspacePath: shared }, { id: 's2', workspacePath: shared }],
        repoRoot,
        dataDir,
      }).canDeleteWorkspace,
      false,
      'Shared workspace must be protected'
    );
    assert.equal(
      assessWorkspacePurgeSafety({
        session: { id: 's1', workspacePath: dedicated },
        allSessions: [{ id: 's1', workspacePath: dedicated }],
        repoRoot,
        dataDir,
      }).canDeleteWorkspace,
      true
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('DELETE /api/sessions/:id supports full purge of dirty worktree + branch AND dedicated workspace directory', async () => {
  const base = makeTempDir('sp-purge-e2e-');
  const dataDir = path.join(base, 'data');
  const gitRepo = path.join(base, 'gitrepo');
  const dedicatedDir = path.join(base, 'standalone-app');
  initTempGitRepo(gitRepo);
  fs.mkdirSync(dedicatedDir, { recursive: true });
  fs.writeFileSync(path.join(dedicatedDir, 'artifact.txt'), 'temp output');

  const studio = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${studio.port}`;

  try {
    const boot = await fetch(`${url}/?token=${studio.token}`);
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' };

    const indexHtml = await boot.text();
    assert.match(indexHtml, /id="modal-delete-session"/);
    assert.match(indexHtml, /id="btn-open-delete-session"/);
    assert.match(indexHtml, /id="chk-purge-workspace"/);
    assert.match(indexHtml, /id="chk-purge-branch"/);

    // 1. Two sessions on same gitRepo -> s2 gets an isolated worktree + branch
    const s1 = studio.store.createSession({ title: 'Primary', workspacePath: gitRepo });
    studio.store.updateSession(s1.id, { phase: 'running' });
    const s2 = studio.store.createSession({ title: 'Temp Worktree', workspacePath: gitRepo });
    const wt = await prepareSessionWorkspace({ session: s2, activeSessions: studio.store.listSessions(), dataDir });
    assert.ok(wt.worktreeBranch && wt.worktreeBranch.startsWith('superpowers/'));
    studio.store.updateSession(s2.id, { effectiveWorkDir: wt.effectiveWorkDir, worktreeBranch: wt.worktreeBranch });
    // Dirty the isolated worktree
    fs.writeFileSync(path.join(wt.effectiveWorkDir, 'temp-dirty.txt'), 'uncommitted');

    // Detail should report purgeInfo (primary gitRepo is shared with s1 so protected, while worktree & branch can be purged!)
    const detail2 = await (await fetch(`${url}/api/sessions/${s2.id}`, { headers })).json();
    assert.equal(detail2.purgeInfo.canDeleteWorkspace, false);
    assert.equal(detail2.purgeInfo.hasWorktree, true);

    // Purge s2 with force=true&deleteBranch=true&deleteWorkspace=true -> removes dirty worktree AND deletes branch, keeps gitRepo safe!
    const del2 = await (await fetch(`${url}/api/sessions/${s2.id}?force=true&deleteBranch=true&deleteWorkspace=true`, {
      method: 'DELETE',
      headers,
    })).json();
    assert.equal(del2.deleted, true);
    assert.equal(del2.worktreeRemoved, true);
    assert.equal(del2.branchDeleted, true);
    assert.equal(del2.workspaceDeleted, false, 'Shared primary gitRepo MUST NOT be deleted');
    assert.equal(fs.existsSync(wt.effectiveWorkDir), false, 'Worktree directory must be removed');
    assert.equal(fs.existsSync(gitRepo), true, 'Primary git repo must remain intact');
    const remainingBranches = execFileSync('git', ['branch', '--list', wt.worktreeBranch], { cwd: gitRepo, encoding: 'utf8' }).trim();
    assert.equal(remainingBranches, '', 'Isolated superpowers/* branch must be deleted on purge');

    // 2. Dedicated standalone workspace -> deleteWorkspace=true permanently removes folder on disk
    const s3 = studio.store.createSession({ title: 'Dedicated App', workspacePath: dedicatedDir });
    const detail3 = await (await fetch(`${url}/api/sessions/${s3.id}`, { headers })).json();
    assert.equal(detail3.purgeInfo.canDeleteWorkspace, true);

    const del3 = await (await fetch(`${url}/api/sessions/${s3.id}?force=true&deleteWorkspace=true`, {
      method: 'DELETE',
      headers,
    })).json();
    assert.equal(del3.deleted, true);
    assert.equal(del3.workspaceDeleted, true);
    assert.equal(fs.existsSync(dedicatedDir), false, 'Dedicated workspace directory must be erased on disk');
    assert.equal(studio.store.getSession(s3.id), null);
  } finally {
    await studio.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  }
});

test('CRITICAL SAFETY: cleanupSessionWorktree NEVER deletes primary repo when orphaned worktree subdir lacks .git file', async () => {
  const base = makeTempDir('sp-wt-orphan-');
  const gitRepo = path.join(base, 'repo');
  const dataDir = path.join(gitRepo, '.superpowers-studio');
  initTempGitRepo(gitRepo);
  fs.writeFileSync(path.join(gitRepo, 'IMPORTANT.txt'), 'DO NOT DELETE');

  // Create an orphaned worktree folder inside dataDir/worktrees/s_orphan/subproj WITHOUT a .git file
  const wtRoot = path.join(dataDir, 'worktrees', 's_orphan');
  const wtSub = path.join(wtRoot, 'subproj');
  fs.mkdirSync(wtSub, { recursive: true });
  fs.writeFileSync(path.join(wtSub, 'draft.txt'), 'temp');

  try {
    const res = await cleanupSessionWorktree({
      session: {
        id: 's_orphan',
        workspacePath: path.join(gitRepo, 'subproj'),
        effectiveWorkDir: wtSub,
        worktreeBranch: 'superpowers/s_orphan',
      },
      dataDir,
      force: true,
      deleteBranch: true,
    });
    assert.equal(res.removed, true);
    assert.equal(fs.existsSync(wtRoot), false, 'Orphaned worktree folder must be cleanly removed');
    assert.equal(fs.existsSync(path.join(gitRepo, 'IMPORTANT.txt')), true, 'Primary git repo MUST NEVER be deleted!');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  }
});
