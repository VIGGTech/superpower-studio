import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { readSkill, loadSkillCatalog } from './skills.mjs';

const MAX_READ_LINES = 800;
const MAX_READ_BYTES = 48 * 1024;
const MAX_CMD_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_CMD_TIMEOUT_MS = 120_000;

export function detectDefaultShell(override = 'auto') {
  if (override && override !== 'auto') {
    if (override === 'powershell') {
      return { executable: 'powershell.exe', argsPrefix: ['-NoProfile', '-Command'], displayName: 'PowerShell' };
    }
    if (override === 'bash') {
      return { executable: 'bash', argsPrefix: ['-c'], displayName: 'bash' };
    }
    return { executable: override, argsPrefix: ['-c'], displayName: path.basename(override) };
  }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null,
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return { executable: c, argsPrefix: ['-c'], displayName: 'Git Bash' };
      }
    }
    return { executable: 'powershell.exe', argsPrefix: ['-NoProfile', '-Command'], displayName: 'PowerShell' };
  }

  if (fs.existsSync('/bin/bash')) {
    return { executable: '/bin/bash', argsPrefix: ['-c'], displayName: 'bash' };
  }
  return { executable: '/bin/sh', argsPrefix: ['-c'], displayName: 'sh' };
}

const TOOL_SCHEMAS = {
  read_file: {
    name: 'read_file',
    description: 'Read a text file inside the workspace (max 800 lines / 48KB).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace root (or inside workspace).' },
        startLine: { type: 'integer', description: '1-based start line (inclusive).' },
        endLine: { type: 'integer', description: '1-based end line (inclusive).' },
      },
      required: ['path'],
    },
  },
  list_files: {
    name: 'list_files',
    description: 'List files and directories inside the workspace (skips .git and node_modules).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subdirectory relative to workspace root (default ".").' },
        maxDepth: { type: 'integer', description: 'Max recursion depth (default 4).' },
      },
    },
  },
  search_files: {
    name: 'search_files',
    description: 'Search text or regex recursively inside workspace files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regex pattern to search for.' },
        path: { type: 'string', description: 'Optional subdirectory relative to workspace root.' },
        isRegex: { type: 'boolean', description: 'Treat query as regex (default false).' },
      },
      required: ['query'],
    },
  },
  load_skill: {
    name: 'load_skill',
    description: 'Load one of the 15 live Superpowers skills (e.g. brainstorming, test-driven-development, systematic-debugging, writing-plans, subagent-driven-development, verification-before-completion).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name.' },
        file: { type: 'string', description: 'Optional supporting file path inside the skill folder (default SKILL.md).' },
      },
      required: ['name'],
    },
  },
  push_visual_screen: {
    name: 'push_visual_screen',
    description: 'Push an HTML content fragment (mockups, SVG/HTML anatomical diagrams, option cards) to the session Visual Companion tab.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Semantic filename like "01-layout.html" or "cardiac-diagram.html".' },
        html: { type: 'string', description: 'HTML fragment (or full HTML document) to display.' },
      },
      required: ['filename', 'html'],
    },
  },
  read_visual_events: {
    name: 'read_visual_events',
    description: 'Read recent user click/selection events captured from the Visual Companion.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max number of recent events (default 20).' },
      },
    },
  },
  view_workspace_image: {
    name: 'view_workspace_image',
    description: 'Visually inspect a PNG, JPEG, WebP, GIF, or SVG file inside the workspace (injects the actual image into your next turn for multimodal visual critique; optionally displays it in the Visual Companion).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to image file inside the workspace (e.g. "outputs/preview.png").' },
        pushToVisual: { type: 'boolean', description: 'Also display this image in the Visual Companion tab (default false).' },
      },
      required: ['path'],
    },
  },
  propose_rules: {
    name: 'propose_rules',
    description: 'Save drafted session rules and implementation plan for the human partner to review and approve before dispatching to the Coordinator.',
    parameters: {
      type: 'object',
      properties: {
        rulesMarkdown: { type: 'string', description: 'Markdown list of constraints, requirements, and rules agreed in the interview.' },
        planMarkdown: { type: 'string', description: 'Step-by-step implementation plan for the Coordinator.' },
      },
      required: ['rulesMarkdown', 'planMarkdown'],
    },
  },
  offer_actions: {
    name: 'offer_actions',
    description: 'Attach clickable one-click action buttons beneath your reply so the human partner can answer questions, pick an approach, or dispatch/relay to Coordinator without typing.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Up to 6 concise clickable action buttons.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button label (e.g. "Proceed with Approach 1", "Approve & Dispatch", "Relay to Coordinator").' },
              kind: { type: 'string', enum: ['reply', 'approve', 'relay', 'pause', 'resume'] },
              value: { type: 'string', description: 'Reply message text (for kind="reply") or directive text (for kind="relay").' },
              style: { type: 'string', enum: ['primary', 'success', 'secondary', 'warn'] },
            },
            required: ['label', 'kind'],
          },
        },
      },
      required: ['actions'],
    },
  },
  relay_to_coordinator: {
    name: 'relay_to_coordinator',
    description: 'Relay updated instructions, clarifications, or follow-up work to the Coordinator agent.',
    parameters: {
      type: 'object',
      properties: {
        instructions: { type: 'string', description: 'Clear, actionable instructions for the Coordinator.' },
        priority: { type: 'string', enum: ['normal', 'urgent'] },
      },
      required: ['instructions'],
    },
  },
  get_coordinator_status: {
    name: 'get_coordinator_status',
    description: 'Inspect the Coordinator agent status, recent actions, and active/completed Experts.',
    parameters: { type: 'object', properties: {} },
  },
  pause_coordinator: {
    name: 'pause_coordinator',
    description: 'Pause the Coordinator and its active Experts cleanly.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
    },
  },
  resume_coordinator: {
    name: 'resume_coordinator',
    description: 'Resume a paused Coordinator with optional new guidance.',
    parameters: {
      type: 'object',
      properties: { guidance: { type: 'string' } },
    },
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a file inside the workspace (creates parent directories automatically).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace an exact target string in an existing workspace file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        target: { type: 'string' },
        replacement: { type: 'string' },
      },
      required: ['path', 'target', 'replacement'],
    },
  },
  run_command: {
    name: 'run_command',
    description: 'Run a shell command inside the session workspace (default timeout 120s, output capped at 32KB).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer' },
      },
      required: ['command'],
    },
  },
  spawn_expert: {
    name: 'spawn_expert',
    description: 'Spawn a specialist Expert/Subagent (e.g. senior-dicom-engineer, hl7-fhir-engineer, anatomical-illustrator, human-physiology-expert, implementer, code-reviewer, debugger, researcher, or an ad-hoc role). Multiple calls in one turn execute in parallel.',
    parameters: {
      type: 'object',
      properties: {
        expertId: { type: 'string', description: 'Optional ID from the Expert Roster (e.g. "senior-dicom-engineer").' },
        role: { type: 'string', description: 'Role title (required if expertId is omitted).' },
        specialty: { type: 'string', description: 'Optional domain specialty notes.' },
        task: { type: 'string', description: 'Clear, complete task assignment and expected output.' },
        context: { type: 'string', description: 'Relevant context/files for this expert.' },
        providerId: { type: 'string', description: 'Optional provider override.' },
        model: { type: 'string', description: 'Optional model override.' },
        readOnly: { type: 'boolean', description: 'Restrict expert to read-only tools.' },
      },
      required: ['task'],
    },
  },
  update_task_progress: {
    name: 'update_task_progress',
    description: 'Update the live Mission Board (Done / Working On / Up Next + ETA) for this session.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Existing task ID (e.g. "task-1") or new slug.' },
        title: { type: 'string', description: 'Task title (required when creating a new task).' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked', 'failed'] },
        assignedAgent: { type: 'string', description: 'Name of the Coordinator or Expert working on this task.' },
        estimateSec: { type: 'integer', description: 'Rough estimated seconds to complete this task.' },
        note: { type: 'string', description: 'Short progress or verification note.' },
      },
      required: ['status'],
    },
  },
  save_attachment_to_workspace: {
    name: 'save_attachment_to_workspace',
    description: 'Copy an uploaded/pasted image attachment from this session into a workspace file path (e.g. references/plate.png).',
    parameters: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string' },
        targetPath: { type: 'string' },
      },
      required: ['attachmentId', 'targetPath'],
    },
  },
  escalate_to_subordinate: {
    name: 'escalate_to_subordinate',
    description: 'Pause autonomous execution and escalate a blocking question upward to the Subordinate agent so the human partner can answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['question'],
    },
  },
  report_complete: {
    name: 'report_complete',
    description: 'Report verified task completion upward to the Subordinate agent.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        verification: { type: 'string', description: 'Concrete commands/tests run and their observed outputs.' },
      },
      required: ['summary', 'verification'],
    },
  },
};

export function getToolDefinitions({
  tier = 'subordinate',
  phase = 'interview',
  readOnly = false,
  allowVisualCompanion = false,
  depth = 0,
} = {}) {
  const names = ['read_file', 'list_files', 'search_files', 'load_skill', 'view_workspace_image'];

  if (tier === 'subordinate') {
    names.push('push_visual_screen', 'read_visual_events', 'offer_actions');
    if (phase === 'interview' || phase === 'ready') {
      names.push('propose_rules');
    } else {
      names.push('relay_to_coordinator', 'get_coordinator_status', 'pause_coordinator', 'resume_coordinator');
    }
  } else if (tier === 'coordinator') {
    names.push(
      'push_visual_screen',
      'read_visual_events',
      'write_file',
      'edit_file',
      'run_command',
      'spawn_expert',
      'update_task_progress',
      'save_attachment_to_workspace',
      'escalate_to_subordinate',
      'report_complete'
    );
  } else if (tier === 'expert') {
    if (allowVisualCompanion) {
      names.push('push_visual_screen', 'read_visual_events');
    }
    if (!readOnly) {
      names.push('write_file', 'edit_file', 'run_command', 'save_attachment_to_workspace');
      if (depth < 2) {
        names.push('spawn_expert');
      }
    }
  }

  return names.map((n) => TOOL_SCHEMAS[n]).filter(Boolean);
}

export function resolveScopedPath(effectiveWorkDir, inputPath) {
  const rootExists = fs.existsSync(effectiveWorkDir);
  const rootReal = rootExists
    ? fs.realpathSync(effectiveWorkDir)
    : path.resolve(effectiveWorkDir);
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootReal, inputPath || '.');

  const rel = path.relative(rootReal, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${inputPath}" resolves outside workspace "${rootReal}"`);
  }

  // Only inspect existing ancestors INSIDE rootReal (never walk above a not-yet-created rootReal)
  if (rootExists) {
    let probe = candidate;
    while (probe && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      const parentRel = path.relative(rootReal, parent);
      if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
        probe = null;
        break;
      }
      probe = parent;
    }
    if (probe && fs.existsSync(probe)) {
      const probeReal = fs.realpathSync(probe);
      const relReal = path.relative(rootReal, probeReal);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        throw new Error(`Symlink "${inputPath}" resolves outside workspace "${rootReal}"`);
      }
    }
  }
  return candidate;
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch { /* process may already have exited */ }
}

function walkFiles(dir, rootDir, maxDepth, currentDepth, out) {
  if (currentDepth > maxDepth || out.length >= 500) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= 500) return;
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.superpowers-studio') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      walkFiles(full, rootDir, maxDepth, currentDepth + 1, out);
    } else {
      out.push(rel);
    }
  }
}

export function createToolExecutor({
  store,
  skillsRoot,
  session,
  effectiveWorkDir,
  signal,
  shellOverride = 'auto',
  allowedTools = null,
  callbacks = {},
}) {
  const shell = detectDefaultShell(shellOverride);
  const allowedSet = allowedTools
    ? (allowedTools instanceof Set ? allowedTools : new Set(allowedTools))
    : null;
  const workDirReal = fs.existsSync(effectiveWorkDir)
    ? fs.realpathSync(effectiveWorkDir)
    : path.resolve(effectiveWorkDir);

  async function execute(name, args = {}) {
    if (allowedSet && !allowedSet.has(name)) {
      return { ok: false, output: `Tool "${name}" is not permitted in this tier or phase.` };
    }
    try {
      switch (name) {
        case 'read_file': {
          const target = resolveScopedPath(workDirReal, args.path);
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
            return { ok: false, output: `File not found: ${args.path}` };
          }
          const raw = fs.readFileSync(target, 'utf8');
          const lines = raw.split(/\r?\n/);
          const start = Math.max(1, Number(args.startLine) || 1);
          const end = Math.min(lines.length, Number(args.endLine) || start + MAX_READ_LINES - 1);
          const slice = lines.slice(start - 1, Math.min(end, start - 1 + MAX_READ_LINES));
          let formatted = slice.map((l, idx) => `${start + idx}: ${l}`).join('\n');
          if (Buffer.byteLength(formatted, 'utf8') > MAX_READ_BYTES) {
            formatted = formatted.slice(0, MAX_READ_BYTES) + '\n... [truncated at 48KB]';
          }
          return { ok: true, output: `File: ${args.path} (lines ${start}-${start + slice.length - 1} of ${lines.length})\n${formatted}` };
        }

        case 'list_files': {
          const base = resolveScopedPath(workDirReal, args.path || '.');
          const out = [];
          walkFiles(base, workDirReal, Number(args.maxDepth) || 4, 1, out);
          return { ok: true, output: out.length ? out.join('\n') : '(empty directory)' };
        }

        case 'search_files': {
          const base = resolveScopedPath(workDirReal, args.path || '.');
          const query = String(args.query || '');
          if (!query) return { ok: false, output: 'query is required' };
          const regex = args.isRegex ? new RegExp(query, 'i') : null;
          const files = [];
          walkFiles(base, workDirReal, 6, 1, files);
          const hits = [];
          for (const rel of files) {
            if (rel.endsWith('/')) continue;
            if (hits.length >= 100) break;
            const full = path.join(workDirReal, rel);
            let stat;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.size > 512 * 1024) continue;
            let text;
            try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
            if (text.includes('\0')) continue;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const matched = regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(query.toLowerCase());
              if (matched) {
                hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (hits.length >= 100) break;
              }
            }
          }
          return { ok: true, output: hits.length ? hits.join('\n') : 'No matches found.' };
        }

        case 'load_skill': {
          const loaded = readSkill(skillsRoot, args.name, args.file || 'SKILL.md');
          if (!loaded) {
            const avail = loadSkillCatalog(skillsRoot).map((s) => s.name).join(', ');
            return { ok: false, output: `Skill "${args.name}" not found. Available: ${avail}` };
          }
          return {
            ok: true,
            output: `# Skill: ${loaded.name} (${loaded.file})\nSupporting files: ${loaded.files.join(', ') || 'none'}\n\n${loaded.content}`,
          };
        }

        case 'push_visual_screen': {
          if (!args.filename || !args.html) {
            return { ok: false, output: 'filename and html are required' };
          }
          const saved = store.writeScreen(session.id, args.filename, args.html);
          if (callbacks.onVisualScreen) callbacks.onVisualScreen(saved);
          return { ok: true, output: `Pushed screen "${saved}" to Visual Companion.` };
        }

        case 'read_visual_events': {
          const events = store.getCompanionEvents(session.id, Number(args.limit) || 20);
          return { ok: true, output: events.length ? JSON.stringify(events, null, 2) : 'No companion events yet.' };
        }

        case 'view_workspace_image': {
          const target = resolveScopedPath(workDirReal, args.path);
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
            return { ok: false, output: `Image file not found: ${args.path}` };
          }
          const ext = path.extname(target).toLowerCase();
          const mimeMap = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
          };
          const mimeType = mimeMap[ext];
          if (!mimeType) {
            return { ok: false, output: `Unsupported image extension "${ext}". Supported: .png, .jpg, .jpeg, .webp, .gif, .svg` };
          }
          const buf = fs.readFileSync(target);
          const meta = store.saveAttachment(session.id, {
            filename: path.basename(target),
            mimeType,
            base64Data: buf.toString('base64'),
          });
          if (args.pushToVisual && callbacks.onVisualScreen) {
            const screenName = `preview-${path.basename(target, ext)}.html`;
            const previewHtml = mimeType === 'image/svg+xml'
              ? `<h2>Preview: ${path.basename(target)}</h2><div style="background:#fff;padding:16px;border-radius:10px">${buf.toString('utf8')}</div>`
              : `<h2>Preview: ${path.basename(target)}</h2><div style="background:#fff;padding:16px;border-radius:10px;text-align:center"><img style="max-width:100%;height:auto" src="data:${mimeType};base64,${buf.toString('base64')}" alt="${path.basename(target)}"></div>`;
            const savedScreen = store.writeScreen(session.id, screenName, previewHtml);
            callbacks.onVisualScreen(savedScreen);
          }
          return {
            ok: true,
            output: `Loaded image "${args.path}" (${mimeType}, ${buf.length} bytes, attachmentId: ${meta.id}) for visual inspection in the next turn.`,
            imageAttachment: meta,
          };
        }

        case 'propose_rules': {
          if (!callbacks.onProposeRules) {
            return { ok: false, output: 'propose_rules is not available in this phase.' };
          }
          const res = await callbacks.onProposeRules({
            rulesMarkdown: String(args.rulesMarkdown || ''),
            planMarkdown: String(args.planMarkdown || ''),
          });
          return { ok: true, output: res || 'Rules and plan saved for human approval.' };
        }

        case 'offer_actions': {
          if (!callbacks.onOfferActions) {
            return { ok: false, output: 'offer_actions is not available here.' };
          }
          const res = await callbacks.onOfferActions(Array.isArray(args.actions) ? args.actions : []);
          return { ok: true, output: res || 'Quick-action buttons shown to your human partner.' };
        }

        case 'relay_to_coordinator': {
          if (!callbacks.onRelayToCoordinator) {
            return { ok: false, output: 'Coordinator relay is not available yet — approve rules first.' };
          }
          const res = await callbacks.onRelayToCoordinator({
            instructions: String(args.instructions || ''),
            priority: args.priority || 'normal',
          });
          return { ok: true, output: res || 'Relayed instructions to Coordinator.' };
        }

        case 'get_coordinator_status': {
          if (!callbacks.onGetCoordinatorStatus) {
            return { ok: false, output: 'Coordinator status unavailable.' };
          }
          const st = await callbacks.onGetCoordinatorStatus();
          return { ok: true, output: typeof st === 'string' ? st : JSON.stringify(st, null, 2) };
        }

        case 'pause_coordinator': {
          if (!callbacks.onPauseCoordinator) return { ok: false, output: 'Cannot pause Coordinator.' };
          const res = await callbacks.onPauseCoordinator(args.reason || 'Paused by Subordinate');
          return { ok: true, output: res || 'Coordinator paused.' };
        }

        case 'resume_coordinator': {
          if (!callbacks.onResumeCoordinator) return { ok: false, output: 'Cannot resume Coordinator.' };
          const res = await callbacks.onResumeCoordinator(args.guidance || '');
          return { ok: true, output: res || 'Coordinator resumed.' };
        }

        case 'write_file': {
          const target = resolveScopedPath(effectiveWorkDir, args.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, String(args.content ?? ''), 'utf8');
          return { ok: true, output: `Wrote ${args.path} (${Buffer.byteLength(String(args.content ?? ''), 'utf8')} bytes).` };
        }

        case 'edit_file': {
          const target = resolveScopedPath(effectiveWorkDir, args.path);
          if (!fs.existsSync(target)) return { ok: false, output: `File not found: ${args.path}` };
          const content = fs.readFileSync(target, 'utf8');
          const find = String(args.target ?? '');
          if (!find || !content.includes(find)) {
            return { ok: false, output: `Target text not found in ${args.path}` };
          }
          const updated = content.split(find).join(String(args.replacement ?? ''));
          fs.writeFileSync(target, updated, 'utf8');
          return { ok: true, output: `Updated ${args.path}.` };
        }

        case 'run_command': {
          const command = String(args.command || '');
          if (!command.trim()) return { ok: false, output: 'command is required' };
          const timeoutMs = Math.min(600_000, Math.max(1000, Number(args.timeoutMs) || DEFAULT_CMD_TIMEOUT_MS));

          return await new Promise((resolve) => {
            if (signal?.aborted) {
              return resolve({ ok: false, output: 'Command aborted before start.' });
            }
            const child = spawn(shell.executable, [...shell.argsPrefix, command], {
              cwd: effectiveWorkDir,
              windowsHide: true,
              detached: process.platform !== 'win32',
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            let output = '';
            let truncated = false;
            const append = (chunk) => {
              if (truncated) return;
              output += chunk.toString('utf8');
              if (Buffer.byteLength(output, 'utf8') > MAX_CMD_OUTPUT_BYTES) {
                output = output.slice(0, MAX_CMD_OUTPUT_BYTES) + '\n... [output truncated at 32KB]';
                truncated = true;
              }
            };
            child.stdout.on('data', append);
            child.stderr.on('data', append);

            let settled = false;
            let aborted = false;
            let timedOut = false;

            const done = (ok, text) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              resolve({ ok, output: text });
            };

            const onAbort = () => {
              aborted = true;
              killProcessTree(child);
              done(false, `${output}\n[aborted by user]`.trim());
            };
            signal?.addEventListener('abort', onAbort, { once: true });

            const timer = setTimeout(() => {
              timedOut = true;
              killProcessTree(child);
              done(false, `${output}\n[command timed out after ${timeoutMs}ms]`.trim());
            }, timeoutMs);

            child.on('error', (err) => {
              done(false, `Failed to start shell "${shell.executable}": ${err.message}`);
            });

            child.on('close', (code) => {
              if (aborted || timedOut) return;
              const summary = `Exit code: ${code}\n${output}`.trim();
              done(code === 0, summary);
            });
          });
        }

        case 'spawn_expert': {
          if (!callbacks.onSpawnExpert) return { ok: false, output: 'spawn_expert is not available here.' };
          const res = await callbacks.onSpawnExpert(args);
          return { ok: true, output: typeof res === 'string' ? res : JSON.stringify(res, null, 2) };
        }

        case 'update_task_progress': {
          if (!callbacks.onUpdateTaskProgress) return { ok: false, output: 'update_task_progress is not available here.' };
          const res = await callbacks.onUpdateTaskProgress(args);
          return { ok: true, output: typeof res === 'string' ? res : JSON.stringify(res, null, 2) };
        }

        case 'save_attachment_to_workspace': {
          const att = store.getAttachment(session.id, args.attachmentId);
          if (!att) return { ok: false, output: `Attachment not found: ${args.attachmentId}` };
          const target = resolveScopedPath(workDirReal, args.targetPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, att.buffer);
          return { ok: true, output: `Saved attachment "${att.filename}" (${att.sizeBytes} bytes) to ${args.targetPath}.` };
        }

        case 'escalate_to_subordinate': {
          if (!callbacks.onEscalate) return { ok: false, output: 'escalate_to_subordinate is not available.' };
          const res = await callbacks.onEscalate({
            question: String(args.question || ''),
            context: String(args.context || ''),
          });
          return { ok: true, output: res || 'Escalated to Subordinate.' };
        }

        case 'report_complete': {
          if (!callbacks.onReportComplete) return { ok: false, output: 'report_complete is not available.' };
          const res = await callbacks.onReportComplete({
            summary: String(args.summary || ''),
            verification: String(args.verification || ''),
          });
          if (res && typeof res === 'object' && 'ok' in res) return res;
          return { ok: true, output: res || 'Completion reported to Subordinate.' };
        }

        default:
          return { ok: false, output: `Unknown tool: ${name}` };
      }
    } catch (err) {
      return { ok: false, output: `Tool error (${name}): ${err.message}` };
    }
  }

  return { execute, shell };
}
