import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runGit(args, cwd, { trim = true } = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return trim ? stdout.trim() : stdout;
}

export async function detectGitRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    const out = await runGit(['rev-parse', '--show-toplevel'], dir);
    return out ? path.resolve(out) : null;
  } catch {
    return null;
  }
}

export async function getWorkspaceStatus(dir) {
  const root = await detectGitRoot(dir);
  if (!root) {
    return { isGit: false, branch: null, changedFiles: [] };
  }
  let branch = null;
  try {
    branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  } catch { /* ignore */ }

  let changedFiles = [];
  try {
    const raw = await runGit(['status', '--porcelain'], dir, { trim: false });
    if (raw) {
      changedFiles = raw.split(/\r?\n/).filter((l) => l.length >= 4).map((line) => ({
        status: line.slice(0, 2).trim() || '??',
        path: line.slice(3).trim(),
      }));
    }
  } catch { /* ignore */ }

  return { isGit: true, branch, changedFiles };
}

export async function prepareSessionWorkspace({ session, activeSessions = [], dataDir }) {
  const workspacePath = path.resolve(session.workspacePath);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // Already has an isolated worktree created earlier
  if (session.worktreeBranch && session.effectiveWorkDir && fs.existsSync(session.effectiveWorkDir)) {
    return {
      effectiveWorkDir: path.resolve(session.effectiveWorkDir),
      worktreeBranch: session.worktreeBranch,
      warning: null,
    };
  }

  const others = activeSessions.filter(
    (s) => s.id !== session.id && (s.phase === 'running' || s.phase === 'paused')
  );

  const gitRoot = await detectGitRoot(workspacePath);
  if (gitRoot) {
    let conflict = false;
    for (const other of others) {
      const otherRoot = await detectGitRoot(other.workspacePath);
      if (otherRoot && path.resolve(otherRoot).toLowerCase() === path.resolve(gitRoot).toLowerCase()) {
        conflict = true;
        break;
      }
    }
    if (!conflict) {
      return { effectiveWorkDir: workspacePath, worktreeBranch: null, warning: null };
    }

    const worktreesRoot = path.join(dataDir, 'worktrees');
    fs.mkdirSync(worktreesRoot, { recursive: true });
    const wtDir = path.join(worktreesRoot, session.id);
    const branch = `superpowers/${session.id}`;
    const subRel = path.relative(gitRoot, workspacePath);
    const resolvedWorkDir = subRel && !subRel.startsWith('..') ? path.resolve(wtDir, subRel) : path.resolve(wtDir);

    if (fs.existsSync(wtDir)) {
      return { effectiveWorkDir: resolvedWorkDir, worktreeBranch: branch, warning: null };
    }

    try {
      await runGit(['worktree', 'add', '-b', branch, wtDir, 'HEAD'], gitRoot);
    } catch {
      // Branch might already exist from a prior run
      await runGit(['worktree', 'add', wtDir, branch], gitRoot);
    }
    return {
      effectiveWorkDir: resolvedWorkDir,
      worktreeBranch: branch,
      warning: null,
    };
  }

  // Non-git folder conflict detection
  const nonGitConflict = others.some(
    (other) => path.resolve(other.effectiveWorkDir || other.workspacePath).toLowerCase() === workspacePath.toLowerCase()
  );
  return {
    effectiveWorkDir: workspacePath,
    worktreeBranch: null,
    warning: nonGitConflict
      ? `Another active session is already using non-git folder "${workspacePath}". Files may collide.`
      : null,
  };
}

export async function cleanupSessionWorktree({ session, force = false }) {
  if (!session?.worktreeBranch || !session?.effectiveWorkDir) {
    return { removed: false };
  }
  const effDir = path.resolve(session.effectiveWorkDir);
  if (effDir.toLowerCase() === path.resolve(session.workspacePath).toLowerCase()) {
    return { removed: false };
  }
  if (!fs.existsSync(effDir)) {
    return { removed: true };
  }

  const wtDir = (await detectGitRoot(effDir)) || effDir;
  const status = await getWorkspaceStatus(wtDir);
  if (!force && status.changedFiles.length > 0) {
    return {
      removed: false,
      dirtyFiles: status.changedFiles.map((f) => `${f.status} ${f.path}`),
    };
  }

  const primaryRoot = await detectGitRoot(session.workspacePath);
  if (primaryRoot) {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(wtDir);
    try {
      await runGit(args, primaryRoot);
    } catch {
      if (force) {
        fs.rmSync(wtDir, { recursive: true, force: true });
        try { await runGit(['worktree', 'prune'], primaryRoot); } catch { /* ignore */ }
      } else {
        throw new Error(`Failed to remove worktree at ${wtDir}`);
      }
    }
  } else if (force) {
    fs.rmSync(wtDir, { recursive: true, force: true });
  }

  // Always preserve the git branch so commits are never silently lost.
  return { removed: true };
}
