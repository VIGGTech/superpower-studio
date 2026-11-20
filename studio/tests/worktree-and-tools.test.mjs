import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import {
  detectGitRoot,
  prepareSessionWorkspace,
  getWorkspaceStatus,
  cleanupSessionWorktree,
} from '../lib/worktree.mjs';
import {
  detectDefaultShell,
  getToolDefinitions,
  createToolExecutor,
} from '../lib/tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-wt-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

test('worktree isolation isolates second concurrent git session and guards dirty cleanup', async () => {
  const repoDir = makeTempDir('sp-repo-');
  const dataDir = makeTempDir('sp-data-');
  const nonGitDir = makeTempDir('sp-nongit-');
  try {
    initGitRepo(repoDir);
    const gitRoot = await detectGitRoot(repoDir);
    assert.ok(gitRoot);

    const s1 = { id: 's_one', workspacePath: repoDir, effectiveWorkDir: repoDir, phase: 'ready' };
    const r1 = await prepareSessionWorkspace({ session: s1, activeSessions: [], dataDir });
    assert.equal(path.resolve(r1.effectiveWorkDir), path.resolve(repoDir));
    assert.equal(r1.worktreeBranch, null);

    // Second concurrent session on same repo gets isolated worktree
    const s2 = { id: 's_two', workspacePath: repoDir, effectiveWorkDir: repoDir, phase: 'ready' };
    const r2 = await prepareSessionWorkspace({
      session: s2,
      activeSessions: [{ ...s1, phase: 'running', effectiveWorkDir: r1.effectiveWorkDir }],
      dataDir,
    });
    assert.notEqual(path.resolve(r2.effectiveWorkDir), path.resolve(repoDir));
    assert.equal(r2.worktreeBranch, 'superpowers/s_two');
    assert.ok(fs.existsSync(path.join(r2.effectiveWorkDir, 'README.md')));

    // Dirty file inside worktree blocks non-force cleanup
    fs.writeFileSync(path.join(r2.effectiveWorkDir, 'dirty.txt'), 'uncommitted', 'utf8');
    const st = await getWorkspaceStatus(r2.effectiveWorkDir);
    assert.equal(st.isGit, true);
    assert.equal(st.branch, 'superpowers/s_two');
    assert.ok(st.changedFiles.some((f) => f.path.includes('dirty.txt')));

    const blocked = await cleanupSessionWorktree({
      session: { ...s2, effectiveWorkDir: r2.effectiveWorkDir, worktreeBranch: r2.worktreeBranch },
      force: false,
    });
    assert.equal(blocked.removed, false);
    assert.ok(blocked.dirtyFiles.length >= 1);

    // Force cleanup removes worktree directory while preserving branch
    const forced = await cleanupSessionWorktree({
      session: { ...s2, effectiveWorkDir: r2.effectiveWorkDir, worktreeBranch: r2.worktreeBranch },
      force: true,
    });
    assert.equal(forced.removed, true);
    const branches = execFileSync('git', ['branch', '--list', 'superpowers/s_two'], { cwd: repoDir, encoding: 'utf8' });
    assert.match(branches, /superpowers\/s_two/);

    // Non-git conflict emits warning
    const ng = await prepareSessionWorkspace({
      session: { id: 's_ng2', workspacePath: nonGitDir, effectiveWorkDir: nonGitDir },
      activeSessions: [{ id: 's_ng1', workspacePath: nonGitDir, effectiveWorkDir: nonGitDir, phase: 'running' }],
      dataDir,
    });
    assert.ok(ng.warning && ng.warning.length > 0);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test('getToolDefinitions strictly scopes tools by Subordinate / Coordinator / Expert tier', () => {
  const subInterview = getToolDefinitions({ tier: 'subordinate', phase: 'interview' }).map((t) => t.name);
  assert.ok(subInterview.includes('propose_rules'));
  assert.ok(subInterview.includes('load_skill'));
  assert.ok(subInterview.includes('push_visual_screen'));
  assert.ok(!subInterview.includes('write_file'));
  assert.ok(!subInterview.includes('run_command'));
  assert.ok(!subInterview.includes('spawn_expert'));
  assert.ok(!subInterview.includes('relay_to_coordinator'));

  const subRunning = getToolDefinitions({ tier: 'subordinate', phase: 'running' }).map((t) => t.name);
  assert.ok(subRunning.includes('relay_to_coordinator'));
  assert.ok(subRunning.includes('get_coordinator_status'));
  assert.ok(subRunning.includes('pause_coordinator'));
  assert.ok(subRunning.includes('resume_coordinator'));
  assert.ok(!subRunning.includes('write_file'));
  assert.ok(!subRunning.includes('run_command'));

  const coord = getToolDefinitions({ tier: 'coordinator', phase: 'running' }).map((t) => t.name);
  assert.ok(coord.includes('write_file'));
  assert.ok(coord.includes('edit_file'));
  assert.ok(coord.includes('run_command'));
  assert.ok(coord.includes('spawn_expert'));
  assert.ok(coord.includes('escalate_to_subordinate'));
  assert.ok(coord.includes('report_complete'));

  const roExpert = getToolDefinitions({ tier: 'expert', phase: 'running', readOnly: true, depth: 1 }).map((t) => t.name);
  assert.ok(roExpert.includes('read_file'));
  assert.ok(!roExpert.includes('write_file'));
  assert.ok(!roExpert.includes('run_command'));

  const illustrator = getToolDefinitions({
    tier: 'expert',
    phase: 'running',
    readOnly: false,
    allowVisualCompanion: true,
    depth: 1,
  }).map((t) => t.name);
  assert.ok(illustrator.includes('push_visual_screen'));
  assert.ok(illustrator.includes('write_file'));
});

test('tool executor enforces workspace path scoping, executes shell with abort kill, and loads skills', async () => {
  const workDir = makeTempDir('sp-work-');
  const dataDir = makeTempDir('sp-data2-');
  const outsideFile = path.join(os.tmpdir(), `sp-outside-${Date.now()}.txt`);
  fs.writeFileSync(outsideFile, 'secret', 'utf8');
  try {
    const store = createStore({ dataDir });
    const session = store.createSession({ title: 'Tools', workspacePath: workDir });

    const shell = detectDefaultShell();
    assert.ok(shell.executable);

    const ac = new AbortController();
    const exec = createToolExecutor({
      store,
      skillsRoot: SKILLS_ROOT,
      session,
      effectiveWorkDir: workDir,
      signal: ac.signal,
    });

    // Write, read, edit, list, search inside workspace
    const w = await exec.execute('write_file', { path: 'src/hello.txt', content: 'hello world\nline two\n' });
    assert.equal(w.ok, true);

    const r = await exec.execute('read_file', { path: 'src/hello.txt' });
    assert.equal(r.ok, true);
    assert.match(r.output, /hello world/);

    const e = await exec.execute('edit_file', { path: 'src/hello.txt', target: 'world', replacement: 'DICOM' });
    assert.equal(e.ok, true);
    assert.match(fs.readFileSync(path.join(workDir, 'src/hello.txt'), 'utf8'), /hello DICOM/);

    const s = await exec.execute('search_files', { query: 'DICOM' });
    assert.equal(s.ok, true);
    assert.match(s.output, /hello\.txt/);

    const l = await exec.execute('list_files', {});
    assert.equal(l.ok, true);
    assert.match(l.output, /hello\.txt/);

    // Reject path traversal & outside absolute path
    const esc1 = await exec.execute('read_file', { path: '../outside.txt' });
    assert.equal(esc1.ok, false);
    assert.match(esc1.output, /outside workspace/i);

    const esc2 = await exec.execute('read_file', { path: outsideFile });
    assert.equal(esc2.ok, false);
    assert.match(esc2.output, /outside workspace/i);

    // Load live Superpowers skill
    const sk = await exec.execute('load_skill', { name: 'test-driven-development' });
    assert.equal(sk.ok, true);
    assert.match(sk.output, /NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST/);

    // Shell command execution
    const cmd = await exec.execute('run_command', { command: 'echo studio-ok' });
    assert.equal(cmd.ok, true);
    assert.match(cmd.output, /studio-ok/);

    // Abort kills running command promptly
    const ac2 = new AbortController();
    const exec2 = createToolExecutor({
      store,
      skillsRoot: SKILLS_ROOT,
      session,
      effectiveWorkDir: workDir,
      signal: ac2.signal,
    });
    const start = Date.now();
    setTimeout(() => ac2.abort(), 250);
    const killed = await exec2.execute('run_command', { command: 'node -e "setTimeout(()=>{}, 15000)"' });
    assert.equal(killed.ok, false);
    assert.ok(Date.now() - start < 5000, 'aborted command should exit promptly');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    try { fs.unlinkSync(outsideFile); } catch { /* ignore */ }
  }
});
