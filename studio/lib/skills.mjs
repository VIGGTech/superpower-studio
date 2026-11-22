import fs from 'node:fs';
import path from 'node:path';

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: markdown };
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[kv[1]] = val;
  }
  return { meta, body: match[2] };
}

function listSupportingFiles(skillDir, relBase = '') {
  const out = [];
  if (!fs.existsSync(skillDir)) return out;
  for (const entry of fs.readdirSync(skillDir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const full = path.join(skillDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSupportingFiles(full, rel));
    } else if (rel !== 'SKILL.md') {
      out.push(rel);
    }
  }
  return out.sort();
}

function readPackMeta(dir, fallback = {}) {
  const metaFile = path.join(dir, 'PACK.json');
  if (fs.existsSync(metaFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      return {
        pack: parsed.id || fallback.pack || 'custom',
        packLabel: parsed.label || fallback.packLabel || 'Custom Pack',
        source: parsed.source || fallback.source || '',
      };
    } catch { /* fall through */ }
  }
  return {
    pack: fallback.pack || 'superpowers',
    packLabel: fallback.packLabel || 'Superpowers Core',
    source: fallback.source || 'obra/superpowers',
  };
}

export function getDefaultSkillRoots(repoRoot) {
  const roots = [
    {
      dir: path.join(repoRoot, 'skills'),
      pack: 'superpowers',
      packLabel: 'Superpowers Core',
      source: 'obra/superpowers',
    },
  ];
  const studioSkillsDir = path.join(repoRoot, 'studio', 'skills');
  if (fs.existsSync(studioSkillsDir)) {
    roots.push({
      dir: studioSkillsDir,
      ...readPackMeta(studioSkillsDir, {
        pack: 'engineering',
        packLabel: 'Engineering Pack',
        source: 'addyosmani/agent-skills',
      }),
    });
  }
  return roots;
}

export function normalizeSkillRoots(skillsRoot) {
  if (!skillsRoot) return [];
  const rawList = Array.isArray(skillsRoot) ? skillsRoot : [skillsRoot];
  const out = [];
  for (const item of rawList) {
    if (!item) continue;
    if (typeof item === 'string') {
      out.push({
        dir: item,
        ...readPackMeta(item),
      });
    } else if (typeof item === 'object' && item.dir) {
      out.push({
        dir: item.dir,
        ...readPackMeta(item.dir, item),
      });
    }
  }
  return out;
}

export function loadSkillCatalog(skillsRoot) {
  const roots = normalizeSkillRoots(skillsRoot);
  const seenNames = new Set();
  const skills = [];
  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    const entries = fs.readdirSync(root.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root.dir, entry.name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const raw = fs.readFileSync(skillFile, 'utf8');
      const { meta } = parseFrontmatter(raw);
      const name = meta.name || entry.name;
      // Earlier roots (e.g. Superpowers Core) take precedence and cannot be shadowed
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      skills.push({
        name,
        dirName: entry.name,
        description: meta.description || '',
        pack: root.pack,
        packLabel: root.packLabel,
        source: root.source,
        dir,
        skillFile,
        files: listSupportingFiles(dir),
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkillPacks(skillsRoot) {
  const roots = normalizeSkillRoots(skillsRoot);
  const catalog = loadSkillCatalog(skillsRoot);
  const counts = new Map();
  for (const s of catalog) {
    counts.set(s.pack, (counts.get(s.pack) || 0) + 1);
  }
  const seen = new Set();
  const packs = [];
  for (const root of roots) {
    if (seen.has(root.pack)) continue;
    seen.add(root.pack);
    const count = counts.get(root.pack) || 0;
    if (count > 0) {
      packs.push({
        id: root.pack,
        label: root.packLabel,
        source: root.source,
        count,
      });
    }
  }
  return packs;
}

export function readSkill(skillsRoot, name, relativeFile = 'SKILL.md') {
  const catalog = loadSkillCatalog(skillsRoot);
  const found = catalog.find((s) => s.name === name || s.dirName === name);
  if (!found) return null;

  const skillDirReal = path.resolve(found.dir);
  const target = path.resolve(skillDirReal, relativeFile || 'SKILL.md');
  const rel = path.relative(skillDirReal, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Requested file "${relativeFile}" resolves outside skill directory "${name}"`);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return null;
  }
  const content = fs.readFileSync(target, 'utf8');
  return {
    name: found.name,
    description: found.description,
    pack: found.pack,
    packLabel: found.packLabel,
    source: found.source,
    file: relativeFile || 'SKILL.md',
    content,
    files: found.files,
  };
}

export function buildBootstrapPrompt({
  skillsRoot,
  tier = 'subordinate',
  phase = 'interview',
  rules = '',
  plan = '',
  workingMemory = '',
  pinnedSkills = [],
  enabledSkillPacks = null,
  shellName = 'shell',
  effectiveWorkDir = '',
  expertRoster = [],
  expertProfile = null,
  extraContext = '',
}) {
  const fullCatalog = loadSkillCatalog(skillsRoot);
  const allowedPacks = Array.isArray(enabledSkillPacks)
    ? new Set(['superpowers', ...enabledSkillPacks])
    : null;
  const catalog = allowedPacks
    ? fullCatalog.filter((s) => allowedPacks.has(s.pack))
    : fullCatalog;
  const usingSp = readSkill(skillsRoot, 'using-superpowers');

  const sections = [];

  if (tier === 'subordinate') {
    if (phase === 'interview' || phase === 'ready') {
      sections.push(
        `# Role: Subordinate Agent (Interview & Mission Preparation — Phase: ${phase.toUpperCase()})
You are the **Subordinate** agent inside Superpowers Studio. You are the human partner's direct point of contact.
- Interview your human partner to clarify intent, constraints, rules, and plan. Use \`load_skill\` (for \`brainstorming\` and \`writing-plans\`) and \`push_visual_screen\` when mockups help.
- **One-click interview buttons:** Whenever you ask a question with concrete choices, propose approaches, or ask whether to proceed, call \`offer_actions\` with 2–4 concise clickable buttons so your human partner can click instead of typing (for example, \`{ label: "Proceed with Approach 1", kind: "reply", value: "Proceed with Approach 1", style: "primary" }\` or \`{ label: "Approve & Dispatch", kind: "approve", style: "success" }\`).
- **CRITICAL STUDIO HANDOFF RULE:** Do NOT load \`subagent-driven-development\` or \`executing-plans\` to execute tasks yourself, and NEVER write "Dispatching subagent..." in plain text during Interview phase. You do NOT have write/shell/spawn tools — the **Coordinator** agent executes the plan!
- As soon as the design & plan are agreed (or your human partner clicks/says "proceed"), call \`propose_rules({ rulesMarkdown, planMarkdown })\` (with clear \`### Task 1: ...\` headings in \`planMarkdown\`) AND call \`offer_actions\` with an \`{ label: "Approve & Dispatch", kind: "approve", style: "success" }\` button.`
      );
    } else {
      sections.push(
        `# Role: Subordinate Agent (Live Supervisor Watchdog & Relay — Phase: ${phase.toUpperCase()})
You are the **Subordinate** agent inside Superpowers Studio. The **Coordinator** agent is ALREADY dispatched and owns autonomous execution!
- **CRITICAL:** Do NOT tell your human partner to click Approve & Dispatch — the mission is already approved and dispatched.
- **Supervisor Watchdog responsibility:** Keep the Coordinator and Experts moving smoothly until **100% of Mission Board tasks are done**. If you receive a \`[Supervisor Watchdog]\` alert that Coordinator stalled or hit repeated errors, immediately diagnose the cause and call \`relay_to_coordinator({ instructions, priority: "urgent" })\` with a concrete fix strategy (e.g. spawn a \`debugger\` or \`implementer\` expert, fix the specific error, and finish remaining tasks).
- Whenever your human partner provides new guidance, style references, or pasted/uploaded images, proactively call \`relay_to_coordinator({ instructions, priority })\` right away so the Coordinator receives the update cleanly on its next turn (include any attached image IDs so Coordinator/Experts can save them via \`save_attachment_to_workspace\`).
- **Never poll in a loop:** Call \`get_coordinator_status\` at most **once** per turn, then reply concisely to your human partner.
- Call \`offer_actions\` when helpful (e.g., \`{ label: "Relay to Coordinator", kind: "relay", value: "..." }\`, \`{ label: "Pause Coordinator", kind: "pause" }\`, \`{ label: "Resume Coordinator", kind: "resume" }\`).`
      );
    }
  } else if (tier === 'coordinator') {
    sections.push(
      `# Role: Coordinator Agent (Autonomous Execution Lead)
You are the **Coordinator** agent inside Superpowers Studio. You execute the approved plan autonomously in \`${effectiveWorkDir}\` using shell \`${shellName}\`.
- Obey the **Locked Rules** below without exception.
- Use Superpowers skills (\`load_skill\`) such as \`subagent-driven-development\`, \`dispatching-parallel-agents\`, \`test-driven-development\`, \`systematic-debugging\`, \`requesting-code-review\`, and \`verification-before-completion\`.
- **Keep the live Mission Board updated:** Call \`update_task_progress({ taskId, status, assignedAgent, estimateSec, note })\` whenever you start a task (\`in_progress\`), finish a task (\`done\`), or hit a blocker (\`blocked\`).
- Break work into focused tasks and delegate to specialist **Experts** using \`spawn_expert\` (pass \`taskId\` if tied to a Mission Board task; emit multiple \`spawn_expert\` calls in one turn to run experts in parallel).
- If the user attached reference images in chat, you or an Expert can copy them into the workspace with \`save_attachment_to_workspace\`.
- If blocked on a human decision or ambiguity not covered by the Locked Rules, call \`escalate_to_subordinate({ question, context })\` — never guess on critical requirements.
- When all work is implemented and verified with fresh test evidence, call \`report_complete({ summary, verification })\`.`
    );
  } else if (tier === 'expert') {
    const title = expertProfile?.name || 'Specialist Expert';
    const persona = expertProfile?.systemPrompt ? `\n${expertProfile.systemPrompt}` : '';
    sections.push(
      `# Role: ${title} (Specialist Expert)
You are a specialist **Expert** dispatched by the Coordinator inside Superpowers Studio.
Workspace: \`${effectiveWorkDir}\` | Shell: \`${shellName}\`
- Obey the **Locked Rules** below without exception.
- Stay focused strictly on your assigned task, verify your work with concrete evidence, and return a concise, high-signal final report for the Coordinator.${persona}`
    );
  }

  if (usingSp?.content) {
    sections.push(`# Superpowers Bootstrap\n${usingSp.content}`);
  }

  if (catalog.length > 0) {
    const packs = listSkillPacks(skillsRoot).filter((p) => !allowedPacks || allowedPacks.has(p.id));
    if (packs.length > 1) {
      const grouped = packs.map((p) => {
        const items = catalog
          .filter((s) => s.pack === p.id)
          .map((s) => `- **${s.name}**: ${s.description}`);
        const src = p.source ? ` — ${p.source}` : '';
        return `## ${p.label} (${items.length}${src})\n${items.join('\n')}`;
      });
      sections.push(
        `# Available Skills (${catalog.length} live skills across ${packs.length} packs — call \`load_skill({ name })\` or \`load_skill({ name, file })\` to read)\n${grouped.join('\n\n')}`
      );
    } else {
      const indexLines = catalog.map((s) => `- **${s.name}**: ${s.description}`);
      sections.push(
        `# Available Superpowers Skills (${catalog.length} live skills — call \`load_skill({ name })\` to read)\n${indexLines.join('\n')}`
      );
    }
  }

  if (tier === 'coordinator' && expertRoster && expertRoster.length > 0) {
    const rosterLines = expertRoster.map((e) => {
      const tags = [
        e.readOnly ? 'read-only default' : '',
        e.allowVisualCompanion ? 'visual companion' : '',
        Array.isArray(e.defaultSkills) && e.defaultSkills.length > 0
          ? `default skills: ${e.defaultSkills.join(', ')}`
          : '',
      ].filter(Boolean);
      return `- \`${e.id}\` (**${e.name}**): ${e.specialty}${tags.length ? ` [${tags.join(' | ')}]` : ''}`;
    });
    sections.push(
      `# Available Expert Roster (pass \`expertId\` to \`spawn_expert\`)\n${rosterLines.join('\n')}`
    );
  }

  const uniquePinned = [...new Set(pinnedSkills || [])];
  if (tier === 'subordinate' && (phase === 'interview' || phase === 'ready') && !uniquePinned.includes('brainstorming')) {
    uniquePinned.unshift('brainstorming');
  }
  for (const skillName of uniquePinned) {
    const loaded = readSkill(skillsRoot, skillName);
    if (loaded) {
      sections.push(`# Active Skill: ${loaded.name}\n${loaded.content}`);
    }
  }

  if (rules && rules.trim()) {
    sections.push(`# Locked Session Rules (MUST OBEY)\n${rules.trim()}`);
  }
  if (plan && plan.trim()) {
    sections.push(`# Approved Implementation Plan\n${plan.trim()}`);
  }
  if (workingMemory && workingMemory.trim()) {
    sections.push(`# Session Working Memory (Auto-Compacted Context)\n${workingMemory.trim()}`);
  }
  if (extraContext && extraContext.trim()) {
    sections.push(`# Additional Context\n${extraContext.trim()}`);
  }

  return sections.join('\n\n---\n\n');
}
