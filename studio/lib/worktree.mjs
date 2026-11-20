import fs from 'node:fs';
import os from 'node:os';
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

function removeDirResilient(targetDir) {
  if (!fs.existsSync(targetDir)) return { removed: true, warning: null };
  try {
    fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
    return { removed: !fs.existsSync(targetDir), warning: null };
  } catch (err) {
    // Best-effort recursive removal of unlocked children on Windows EBUSY/EPERM
    const sweep = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        try {
          if (ent.isDirectory()) {
            sweep(full);
            fs.rmdirSync(full);
          } else {
            fs.unlinkSync(full);
          }
        } catch { /* locked entry — skip */ }
      }
    };
    sweep(targetDir);
    try { fs.rmdirSync(targetDir); } catch { /* still locked */ }
    if (!fs.existsSync(targetDir)) return { removed: true, warning: null };
    return {
      removed: false,
      warning: `Folder "${targetDir}" is locked by another process (${err.code || err.message}). Close any Explorer/terminal window using it and delete the leftover folder manually.`,
    };
  }
}

function resolveIsolatedWorktreeRoot(session, dataDir = '') {
  if (!session?.id || !session?.effectiveWorkDir) return null;
  const effDir = path.resolve(session.effectiveWorkDir);
  if (dataDir) {
    const expected = path.resolve(dataDir, 'worktrees', session.id);
    if (isSameOrAncestor(expected, effDir)) return expected;
  }
  // Fallback when dataDir is not explicitly passed: walk up only to .../worktrees/<session.id>
  let cur = effDir;
  while (true) {
    const parent = path.dirname(cur);
    if (path.basename(cur) === session.id && path.basename(parent).toLowerCase() === 'worktrees') {
      return cur;
    }
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export async function cleanupSessionWorktree({ session, dataDir = '', force = false, deleteBranch = false }) {
  if (!session?.worktreeBranch || !session?.effectiveWorkDir) {
    return { removed: false, branchDeleted: false };
  }
  const effDir = path.resolve(session.effectiveWorkDir);
  if (normalizeForCompare(effDir) === normalizeForCompare(session.workspacePath)) {
    return { removed: false, branchDeleted: false };
  }

  const primaryRoot = await detectGitRoot(session.workspacePath);
  const wtDir = resolveIsolatedWorktreeRoot(session, dataDir);

  // HARD SAFETY INVARIANT: never touch anything outside worktrees/<session.id> or any ancestor of primaryRoot/workspacePath
  if (!wtDir) {
    return { removed: false, branchDeleted: false };
  }
  if (primaryRoot && isSameOrAncestor(wtDir, primaryRoot)) {
    throw new Error(`Safety block: refused to remove primary repository root "${primaryRoot}"`);
  }
  if (session.workspacePath && isSameOrAncestor(wtDir, session.workspacePath)) {
    throw new Error(`Safety block: refused to remove primary workspace "${session.workspacePath}"`);
  }

  let removed = false;
  let warning = null;

  if (!fs.existsSync(wtDir)) {
    removed = true;
    if (primaryRoot) {
      try { await runGit(['worktree', 'prune'], primaryRoot); } catch { /* ignore */ }
    }
  } else {
    const hasGitMarker = fs.existsSync(path.join(wtDir, '.git'));
    if (hasGitMarker) {
      const status = await getWorkspaceStatus(wtDir);
      if (!force && status.changedFiles.length > 0) {
        return {
          removed: false,
          branchDeleted: false,
          dirtyFiles: status.changedFiles.map((f) => `${f.status} ${f.path}`),
        };
      }
      if (primaryRoot) {
        const args = ['worktree', 'remove'];
        if (force) args.push('--force');
        args.push(wtDir);
        try {
          await runGit(args, primaryRoot);
          removed = true;
        } catch {
          if (force) {
            const rm = removeDirResilient(wtDir);
            removed = rm.removed;
            warning = rm.warning;
            try { await runGit(['worktree', 'prune'], primaryRoot); } catch { /* ignore */ }
          } else {
            throw new Error(`Failed to remove worktree at ${wtDir}`);
          }
        }
      } else if (force) {
        const rm = removeDirResilient(wtDir);
        removed = rm.removed;
        warning = rm.warning;
      }
    } else {
      // Orphaned/partial worktree folder whose .git pointer is already gone — remove resiliently
      const rm = removeDirResilient(wtDir);
      removed = rm.removed;
      warning = rm.warning;
      if (primaryRoot) {
        try { await runGit(['worktree', 'prune'], primaryRoot); } catch { /* ignore */ }
      }
    }
  }

  let branchDeleted = false;
  if ((removed || force) && deleteBranch && primaryRoot && String(session.worktreeBranch).startsWith('superpowers/')) {
    try {
      await runGit(['branch', '-D', session.worktreeBranch], primaryRoot);
      branchDeleted = true;
    } catch {
      branchDeleted = false;
    }
  }

  return { removed, branchDeleted, warning };
}

function normalizeForCompare(p) {
  const resolved = path.resolve(String(p || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrAncestor(ancestor, descendant) {
  const a = normalizeForCompare(ancestor);
  const d = normalizeForCompare(descendant);
  if (a === d) return true;
  const sep = path.sep;
  return d.startsWith(a.endsWith(sep) ? a : a + sep);
}

export function assessWorkspacePurgeSafety({ session, allSessions = [], repoRoot = '', dataDir = '' } = {}) {
  const hasWorktree = Boolean(
    session?.worktreeBranch
    && session?.effectiveWorkDir
    && normalizeForCompare(session.effectiveWorkDir) !== normalizeForCompare(session.workspacePath)
  );
  const worktreeDir = hasWorktree ? path.resolve(session.effectiveWorkDir) : null;
  const targetDir = session?.workspacePath ? path.resolve(session.workspacePath) : '';

  if (!targetDir) {
    return { canDeleteWorkspace: false, targetDir: '', hasWorktree, worktreeDir, worktreeBranch: session?.worktreeBranch || null, reason: 'No workspace path configured.' };
  }

  const parsedRoot = path.parse(targetDir).root;
  if (normalizeForCompare(targetDir) === normalizeForCompare(parsedRoot)) {
    return { canDeleteWorkspace: false, targetDir, hasWorktree, worktreeDir, worktreeBranch: session?.worktreeBranch || null, reason: 'Drive / filesystem root is protected.' };
  }

  const home = os.homedir();
  const protectedDirs = [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    process.env.SystemRoot || 'C:\\Windows',
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ].filter(Boolean);

  for (const pDir of protectedDirs) {
    if (isSameOrAncestor(targetDir, pDir)) {
      return {
        canDeleteWorkspace: false,
        targetDir,
        hasWorktree,
        worktreeDir,
        worktreeBranch: session?.worktreeBranch || null,
        reason: `Protected system/user folder (${pDir}) cannot be deleted.`,
      };
    }
  }

  if (repoRoot && isSameOrAncestor(targetDir, repoRoot)) {
    return {
      canDeleteWorkspace: false,
      targetDir,
      hasWorktree,
      worktreeDir,
      worktreeBranch: session?.worktreeBranch || null,
      reason: 'Primary Studio repository folder is protected (only the isolated worktree & session data can be purged).',
    };
  }

  if (dataDir && isSameOrAncestor(targetDir, dataDir)) {
    return {
      canDeleteWorkspace: false,
      targetDir,
      hasWorktree,
      worktreeDir,
      worktreeBranch: session?.worktreeBranch || null,
      reason: 'Studio data directory is protected.',
    };
  }

  const sharedWith = (allSessions || []).find((other) => {
    if (!other || other.id === session.id) return false;
    const otherPaths = [other.workspacePath, other.effectiveWorkDir].filter(Boolean);
    return otherPaths.some((op) => isSameOrAncestor(targetDir, op) || isSameOrAncestor(op, targetDir));
  });
  if (sharedWith) {
    return {
      canDeleteWorkspace: false,
      targetDir,
      hasWorktree,
      worktreeDir,
      worktreeBranch: session?.worktreeBranch || null,
      reason: `Workspace folder is shared with another session ("${sharedWith.title || sharedWith.id}").`,
    };
  }

  return {
    canDeleteWorkspace: true,
    targetDir,
    hasWorktree,
    worktreeDir,
    worktreeBranch: session?.worktreeBranch || null,
    reason: null,
  };
}

export function purgeWorkspaceDirectory({ session, allSessions = [], repoRoot = '', dataDir = '' } = {}) {
  const safety = assessWorkspacePurgeSafety({ session, allSessions, repoRoot, dataDir });
  if (!safety.canDeleteWorkspace) {
    return { deleted: false, blocked: true, path: safety.targetDir, reason: safety.reason };
  }
  if (!fs.existsSync(safety.targetDir)) {
    return { deleted: false, blocked: false, path: safety.targetDir, reason: 'Directory already absent.' };
  }
  const rm = removeDirResilient(safety.targetDir);
  return { deleted: rm.removed, blocked: false, path: safety.targetDir, reason: rm.warning };
}
