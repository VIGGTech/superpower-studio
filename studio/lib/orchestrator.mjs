import crypto from 'node:crypto';
import { buildBootstrapPrompt, readSkill } from './skills.mjs';
import { streamChat as defaultStreamChat } from './providers/index.mjs';
import { prepareSessionWorkspace } from './worktree.mjs';
import { detectDefaultShell, getToolDefinitions, createToolExecutor } from './tools.mjs';

const DEFAULT_PROMPT_BUDGET_CHARS = 60_000;
const DEFAULT_EXPERT_MAX_TURNS = 40;
const MAX_SUBORDINATE_TOOL_STEPS = 8;

export function parsePlanTasks(planMarkdown = '') {
  const text = String(planMarkdown || '');
  if (!text.trim()) return [];
  const tasks = [];
  const seen = new Set();

  const addTask = (rawTitle) => {
    const title = String(rawTitle || '').replace(/\*\*/g, '').trim();
    if (!title || title.length < 3) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tasks.push({
      id: `task-${tasks.length + 1}`,
      title,
      status: 'pending',
      assignedAgent: null,
      assignedModel: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      estimateSec: null,
      note: '',
    });
  };

  // Priority 1: Markdown headings like "### Task 1: Title" or "## Task 2 - Title"
  for (const m of text.matchAll(/^#{1,4}\s+Task\s*\d*\s*[:\-–—]\s*(.+)$/gim)) {
    addTask(m[1]);
  }
  if (tasks.length > 0) return tasks;

  // Priority 2: Top-level numbered list items ("1. Do X")
  for (const m of text.matchAll(/^\s*\d+\.\s+(.+)$/gm)) {
    addTask(m[1]);
  }
  if (tasks.length > 0) return tasks.slice(0, 25);

  // Priority 3: Markdown checkboxes ("- [ ] Do X")
  for (const m of text.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/gm)) {
    addTask(m[1]);
  }
  return tasks.slice(0, 25);
}

export function computeMissionEta(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  const done = list.filter((t) => t.status === 'done');
  const inProgress = list.filter((t) => t.status === 'in_progress');
  const remaining = list.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked');

  const durationsSec = done
    .map((t) => (typeof t.durationMs === 'number' && t.durationMs > 0 ? t.durationMs / 1000 : null))
    .filter((v) => v !== null);

  let etaSeconds = null;
  let etaBasis = 'estimating';

  if (remaining.length === 0 && list.length > 0) {
    etaSeconds = 0;
    etaBasis = 'complete';
  } else if (durationsSec.length > 0) {
    const avgSec = durationsSec.reduce((a, b) => a + b, 0) / durationsSec.length;
    etaSeconds = Math.round(avgSec * remaining.length);
    etaBasis = 'rolling-average';
  } else {
    const estValues = remaining
      .map((t) => (typeof t.estimateSec === 'number' && t.estimateSec > 0 ? t.estimateSec : null))
      .filter((v) => v !== null);
    if (estValues.length > 0) {
      const avgEst = estValues.reduce((a, b) => a + b, 0) / estValues.length;
      etaSeconds = Math.round(
        remaining.reduce((sum, t) => sum + (t.estimateSec > 0 ? t.estimateSec : avgEst), 0)
      );
      etaBasis = 'coordinator-estimate';
    }
  }

  return {
    doneCount: done.length,
    inProgressCount: inProgress.length,
    pendingCount: list.filter((t) => t.status === 'pending').length,
    totalCount: list.length,
    etaSeconds,
    etaBasis,
  };
}

function extractFallbackPlanFromMessages(messages = []) {
  const assistantMsgs = messages.filter((m) => m.role === 'assistant' && String(m.content || '').trim().length > 40);
  // Prefer the latest assistant message that contains structured tasks/plan
  for (let i = assistantMsgs.length - 1; i >= 0; i--) {
    const c = String(assistantMsgs[i].content);
    if (/###\s+Task\s+\d+|Implementation Plan|^\s*1\.\s+/im.test(c)) {
      return c;
    }
  }
  return assistantMsgs.length > 0 ? String(assistantMsgs[assistantMsgs.length - 1].content) : '';
}

export function buildPromptWindow(messages, { maxChars = DEFAULT_PROMPT_BUDGET_CHARS } = {}) {
  const cloned = messages
    .filter((m) => m && m.role && m.role !== 'system')
    .map((m) => ({ ...m }));

  const totalChars = (list) => list.reduce((sum, m) => {
    const c = typeof m.content === 'string' ? m.content.length : 0;
    const t = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
    return sum + c + t + 32;
  }, 0);

  if (totalChars(cloned) <= maxChars) return cloned;

  // Pass 1: Trim older large tool results (protecting only the very latest 2 messages first)
  const protectCount = Math.min(2, cloned.length);
  for (let i = 0; i < cloned.length - protectCount && totalChars(cloned) > maxChars; i++) {
    if (cloned[i].role === 'tool' && String(cloned[i].content || '').length > 500) {
      const origLen = cloned[i].content.length;
      const preview = String(cloned[i].content).slice(0, 300);
      cloned[i].content = `${preview}\n... [trimmed earlier tool output (${origLen} chars)]`;
    }
  }
  if (totalChars(cloned) <= maxChars) return cloned;

  // Pass 1b: If still over budget, trim any remaining oversized tool results too
  for (let i = 0; i < cloned.length && totalChars(cloned) > maxChars; i++) {
    if (cloned[i].role === 'tool' && String(cloned[i].content || '').length > 500) {
      const origLen = cloned[i].content.length;
      const preview = String(cloned[i].content).slice(0, 300);
      cloned[i].content = `${preview}\n... [trimmed earlier tool output (${origLen} chars)]`;
    }
  }
  if (totalChars(cloned) <= maxChars) return cloned;

  // Pass 2: Drop oldest turns while guaranteeing result starts on role='user' and never orphans tool messages
  // Build atomic turn groups so an assistant(toolCalls) + its following tool messages are never split.
  const groups = [];
  for (let i = 0; i < cloned.length; i++) {
    const m = cloned[i];
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const grp = [m];
      while (i + 1 < cloned.length && cloned[i + 1].role === 'tool') {
        grp.push(cloned[++i]);
      }
      groups.push(grp);
    } else if (m.role === 'tool') {
      // Orphaned tool message at input; drop it cleanly
      continue;
    } else {
      groups.push([m]);
    }
  }

  // Keep the earliest user message as an anchor if needed, and drop older non-anchor groups from the front
  const flatGroups = (gs) => gs.flat();
  let kept = groups.slice();
  while (kept.length > 2 && totalChars(flatGroups(kept)) > maxChars) {
    // Prefer dropping from index 1 if index 0 is the anchor user message and index 1 isn't the only remaining turn
    if (kept[0][0]?.role === 'user' && kept.length > 2 && kept[1][0]?.role !== 'user') {
      kept.splice(1, 1);
    } else {
      kept.shift();
    }
  }

  // Ensure the window strictly starts with a 'user' message (required by Anthropic & Gemini)
  const firstUser = cloned.find((m) => m.role === 'user');
  while (kept.length > 0 && kept[0][0]?.role !== 'user') {
    if (kept.length > 1) {
      kept.shift();
    } else {
      break;
    }
  }
  const result = flatGroups(kept);
  if (result.length > 0 && result[0].role !== 'user') {
    const anchor = firstUser
      ? { role: 'user', content: String(firstUser.content || '').slice(0, 500) }
      : { role: 'user', content: 'Continue.' };
    result.unshift(anchor);
  }
  return result;
}

export function createOrchestrator({
  store,
  skillsRoot,
  streamChatImpl = defaultStreamChat,
  emitEvent = () => {},
}) {
  const runtimes = new Map();
  let workspacePrepLock = Promise.resolve();

  function withWorkspaceLock(fn) {
    const next = workspacePrepLock.then(fn, fn);
    workspacePrepLock = next.then(() => {}, () => {});
    return next;
  }

  function getRuntime(sessionId) {
    if (!runtimes.has(sessionId)) {
      runtimes.set(sessionId, {
        coordinatorAbort: null,
        coordinatorPromise: null,
        directiveQueue: [],
        pauseRequested: false,
        subordinateQueue: Promise.resolve(),
        activeExperts: new Set(),
        consecutiveRecoveries: 0,
      });
    }
    return runtimes.get(sessionId);
  }

  function resolveProviderAndModel(session, tier, explicitProviderId = '', explicitModel = '', expertProfile = null) {
    let providerId = session.providerId;
    let model = session.model;

    if (tier === 'coordinator') {
      providerId = session.coordinatorProviderId || session.providerId;
      model = session.coordinatorModel || (session.coordinatorProviderId ? '' : session.model);
    } else if (tier === 'expert') {
      providerId =
        explicitProviderId ||
        expertProfile?.providerId ||
        session.expertProviderId ||
        session.coordinatorProviderId ||
        session.providerId;
      model =
        explicitModel ||
        expertProfile?.model ||
        session.expertModel ||
        (explicitProviderId || expertProfile?.providerId || session.expertProviderId
          ? ''
          : (session.coordinatorModel || session.model));
    }

    const provider = store.getProvider(providerId) || store.getProviders()[0];
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    const resolvedModel = model || provider.defaultModel;
    return { provider, model: resolvedModel };
  }

  function expandSlashSkill(text) {
    const match = String(text || '').match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return text;
    const skillName = match[1];
    const rest = (match[2] || '').trim();
    const loaded = readSkill(skillsRoot, skillName);
    if (!loaded) return text;
    return `[User invoked skill: ${loaded.name}]\n${rest || `Apply the ${loaded.name} skill.`}\n\n<loaded_skill name="${loaded.name}">\n${loaded.content}\n</loaded_skill>`;
  }

  const DEFAULT_MAX_IMAGES_PER_REQUEST = 3;

  function isImageLimitError(err) {
    const msg = String(err?.message || '');
    return /more images than the limit|too many images|maximum.*images|image.*limit|at most \d+ images/i.test(msg);
  }

  function hydrateMessages(sessionId, messages, { maxImages = DEFAULT_MAX_IMAGES_PER_REQUEST } = {}) {
    const list = messages || [];
    const out = new Array(list.length);
    let remainingRaster = Math.max(0, Number(maxImages) || 0);

    // Walk newest -> oldest so only the most recent raster images consume the per-request budget
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.role !== 'user' || !Array.isArray(m.attachments) || m.attachments.length === 0) {
        out[i] = m;
        continue;
      }
      const hydratedReversed = [];
      const omittedNames = [];
      for (let j = m.attachments.length - 1; j >= 0; j--) {
        const meta = m.attachments[j];
        const full = store.getAttachment(sessionId, meta.id);
        if (!full) continue;
        if (full.mimeType === 'image/svg+xml') {
          hydratedReversed.push({
            id: full.id,
            filename: full.filename,
            mimeType: full.mimeType,
            svgText: full.buffer.toString('utf8'),
          });
        } else if (remainingRaster > 0) {
          remainingRaster--;
          hydratedReversed.push({
            id: full.id,
            filename: full.filename,
            mimeType: full.mimeType,
            base64: full.buffer.toString('base64'),
          });
        } else {
          omittedNames.push(full.filename);
        }
      }
      const hydrated = hydratedReversed.reverse();
      if (hydrated.length > 0 && omittedNames.length === 0) {
        out[i] = { ...m, hydratedAttachments: hydrated };
      } else if (omittedNames.length > 0) {
        const note = `\n[Earlier image attachment(s) omitted to stay within provider image limit: ${omittedNames.reverse().join(', ')}]`;
        const nextMsg = { ...m, content: `${m.content || ''}${note}`.trim() };
        if (hydrated.length > 0) nextMsg.hydratedAttachments = hydrated;
        else delete nextMsg.hydratedAttachments;
        out[i] = nextMsg;
      } else {
        out[i] = m;
      }
    }
    return out;
  }

  async function callModelWithOverflowRetry({
    sessionId,
    provider,
    model,
    systemPrompt,
    messages,
    tools,
    signal,
    onText,
    onReasoning,
  }) {
    const attemptCall = async (maxChars, maxImages) => {
      const hydrated = sessionId ? hydrateMessages(sessionId, messages, { maxImages }) : messages;
      const windowed = buildPromptWindow(hydrated, { maxChars });
      return await streamChatImpl({
        provider,
        model,
        systemPrompt,
        messages: windowed,
        tools,
        signal,
        onText,
        onReasoning,
      });
    };

    try {
      return await attemptCall(DEFAULT_PROMPT_BUDGET_CHARS, DEFAULT_MAX_IMAGES_PER_REQUEST);
    } catch (err) {
      if (isImageLimitError(err)) {
        try {
          return await attemptCall(DEFAULT_PROMPT_BUDGET_CHARS, 1);
        } catch (err2) {
          if (isImageLimitError(err2)) {
            return await attemptCall(DEFAULT_PROMPT_BUDGET_CHARS, 0);
          }
          throw err2;
        }
      }
      if (err?.isContextOverflow) {
        return await attemptCall(16_000, 1);
      }
      throw err;
    }
  }

  function updateTaskProgress(sessionId, patch = {}) {
    const session = store.getSession(sessionId);
    if (!session) return null;
    const tasks = Array.isArray(session.tasks) ? session.tasks.map((t) => ({ ...t })) : [];
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    let task = patch.taskId ? tasks.find((t) => t.id === patch.taskId) : null;
    if (!task && patch.title) {
      task = tasks.find((t) => t.title.toLowerCase() === String(patch.title).toLowerCase());
    }
    if (!task) {
      task = {
        id: patch.taskId || `task-${tasks.length + 1}`,
        title: patch.title || patch.taskId || `Task ${tasks.length + 1}`,
        status: 'pending',
        assignedAgent: null,
        assignedModel: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        estimateSec: null,
        note: '',
      };
      tasks.push(task);
    }

    const prevStatus = task.status;
    if (patch.title) task.title = String(patch.title);
    if (patch.status) task.status = patch.status;
    if (patch.assignedAgent !== undefined) task.assignedAgent = patch.assignedAgent;
    if (patch.assignedModel !== undefined) task.assignedModel = patch.assignedModel;
    if (typeof patch.estimateSec === 'number' && patch.estimateSec > 0) task.estimateSec = patch.estimateSec;
    if (patch.note !== undefined) task.note = String(patch.note);

    if (task.status === 'in_progress' && !task.startedAt) {
      task.startedAt = nowIso;
    }
    if (task.status === 'done' && prevStatus !== 'done') {
      task.completedAt = nowIso;
      if (task.startedAt) {
        task.durationMs = Math.max(1000, nowMs - Date.parse(task.startedAt));
      } else {
        task.durationMs = 1000;
      }
    }

    store.updateSession(sessionId, { tasks });
    broadcastSession(sessionId);
    return task;
  }

  function broadcastSession(sessionId) {
    const session = store.getSession(sessionId);
    if (!session) return null;
    const coordinator = store.getCoordinator(sessionId);
    const experts = store.listExperts(sessionId);
    const missionSummary = computeMissionEta(session.tasks || []);
    const elapsedSeconds = session.startedAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(session.startedAt)) / 1000))
      : 0;
    emitEvent({
      type: 'session_updated',
      sessionId,
      session: {
        ...session,
        coordinatorStatus: coordinator.status,
        coordinatorCurrentTool: coordinator.currentTool || null,
        activeExperts: experts.filter((e) => e.status === 'running').length,
        totalExperts: experts.length,
        missionSummary: { ...missionSummary, elapsedSeconds },
      },
    });
    return session;
  }

  function getSessionActiveExperts(session) {
    const all = store.getExpertRoster();
    if (!Array.isArray(session?.enabledExpertIds)) return all;
    const allowed = new Set(session.enabledExpertIds);
    return all.filter((e) => allowed.has(e.id));
  }

  async function runExpert({
    sessionId,
    args,
    parentSignal,
    depth = 1,
  }) {
    const session = store.getSession(sessionId);
    const runtime = getRuntime(sessionId);
    if (args.expertId && Array.isArray(session?.enabledExpertIds) && !session.enabledExpertIds.includes(args.expertId)) {
      const enabledIds = getSessionActiveExperts(session).map((e) => e.id);
      return `[Expert spawn blocked] Expert "${args.expertId}" is disabled for this session. Enabled experts: ${enabledIds.join(', ') || '(none — handle directly or omit expertId)'}.`;
    }
    const profile = args.expertId ? store.getExpertProfile(args.expertId) : null;
    const expertId = `exp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const role = args.role || profile?.name || 'Specialist Expert';
    const specialty = args.specialty || profile?.specialty || '';
    const readOnly = args.readOnly !== undefined ? Boolean(args.readOnly) : Boolean(profile?.readOnly);
    const allowVisualCompanion = Boolean(profile?.allowVisualCompanion);

    const { provider, model } = resolveProviderAndModel(
      session,
      'expert',
      args.providerId || '',
      args.model || '',
      profile
    );

    const expertRecord = {
      id: expertId,
      expertId: profile?.id || null,
      role,
      specialty,
      providerId: provider.id,
      model,
      readOnly,
      depth,
      taskId: args.taskId || null,
      task: args.task,
      status: 'running',
      currentTool: null,
      result: '',
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      messages: [
        {
          role: 'user',
          content: [
            `Task: ${args.task}`,
            args.context ? `\nContext:\n${args.context}` : '',
          ].join(''),
        },
      ],
    };

    if (args.taskId) {
      updateTaskProgress(sessionId, {
        taskId: args.taskId,
        status: 'in_progress',
        assignedAgent: role,
        assignedModel: `${provider.id}/${model}`,
      });
    }

    store.saveExpert(sessionId, expertRecord);
    runtime.activeExperts.add(expertId);
    emitEvent({ type: 'expert_event', sessionId, expertId, status: 'running', role, model, taskId: args.taskId || null, action: 'started' });
    broadcastSession(sessionId);

    const settings = store.getSettings();
    const shell = detectDefaultShell(settings.shell);
    const expertPinnedSkills = [
      ...new Set([
        ...(Array.isArray(session.pinnedSkills) ? session.pinnedSkills : []),
        ...(Array.isArray(profile?.defaultSkills) ? profile.defaultSkills : []),
      ]),
    ];
    const systemPrompt = buildBootstrapPrompt({
      skillsRoot,
      tier: 'expert',
      phase: 'running',
      rules: session.rules,
      plan: session.plan,
      pinnedSkills: expertPinnedSkills,
      enabledSkillPacks: session.enabledSkillPacks,
      shellName: shell.displayName,
      effectiveWorkDir: session.effectiveWorkDir,
      expertProfile: profile || { name: role, systemPrompt: specialty ? `Specialty: ${specialty}` : '' },
    });

    const tools = getToolDefinitions({
      tier: 'expert',
      phase: 'running',
      readOnly,
      allowVisualCompanion,
      depth,
    });

    const executor = createToolExecutor({
      store,
      skillsRoot,
      session,
      effectiveWorkDir: session.effectiveWorkDir,
      signal: parentSignal,
      shellOverride: settings.shell,
      allowedTools: new Set(tools.map((t) => t.name)),
      callbacks: {
        onVisualScreen: (filename) => {
          emitEvent({ type: 'companion_reload', sessionId, filename });
        },
        onSpawnExpert: !readOnly && depth < 2
          ? (childArgs) => runExpert({ sessionId, args: childArgs, parentSignal, depth: depth + 1 })
          : undefined,
      },
    });

    try {
      let finalText = '';
      for (let turn = 0; turn < DEFAULT_EXPERT_MAX_TURNS; turn++) {
        if (parentSignal?.aborted) {
          throw Object.assign(new Error('Expert aborted'), { name: 'AbortError' });
        }

        const reply = await callModelWithOverflowRetry({
          sessionId,
          provider,
          model,
          systemPrompt,
          messages: expertRecord.messages,
          tools,
          signal: parentSignal,
          onText: (delta) => {
            emitEvent({ type: 'expert_event', sessionId, expertId, action: 'delta', delta });
          },
          onReasoning: (delta) => {
            emitEvent({ type: 'expert_event', sessionId, expertId, action: 'reasoning', delta });
          },
        });

        expertRecord.messages.push({
          role: 'assistant',
          content: reply.content || '',
          reasoning: reply.reasoning || '',
          toolCalls: reply.toolCalls || [],
        });
        store.saveExpert(sessionId, expertRecord);

        if (!reply.toolCalls || reply.toolCalls.length === 0) {
          finalText = reply.content || '(Expert completed with empty output)';
          break;
        }

        const results = await Promise.all(
          reply.toolCalls.map(async (tc) => {
            expertRecord.currentTool = tc.name;
            store.saveExpert(sessionId, expertRecord);
            emitEvent({ type: 'expert_event', sessionId, expertId, action: 'tool_call', toolCall: tc });
            const res = await executor.execute(tc.name, tc.arguments);
            expertRecord.currentTool = null;
            emitEvent({ type: 'expert_event', sessionId, expertId, action: 'tool_result', toolCallId: tc.id, name: tc.name, result: res });
            return { tc, res };
          })
        );

        const visualAttachments = [];
        for (const { tc, res } of results) {
          expertRecord.messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: res.output,
          });
          if (res.imageAttachment) visualAttachments.push(res.imageAttachment);
        }
        if (visualAttachments.length > 0) {
          expertRecord.messages.push({
            role: 'user',
            content: `Visual inspection of workspace image(s): ${visualAttachments.map((a) => a.filename).join(', ')}. Critique anatomical accuracy, layout, alignment, and defects honestly before continuing.`,
            attachments: visualAttachments,
          });
        }
        store.saveExpert(sessionId, expertRecord);
      }

      expertRecord.status = 'completed';
      expertRecord.currentTool = null;
      expertRecord.completedAt = new Date().toISOString();
      expertRecord.result = finalText || 'Expert reached turn limit.';
      store.saveExpert(sessionId, expertRecord);
      emitEvent({ type: 'expert_event', sessionId, expertId, status: 'completed', role, model, action: 'completed' });
      return `[Expert ${role} (${expertId}) — completed]\n${expertRecord.result}`;
    } catch (err) {
      const isAbort = err?.name === 'AbortError' || parentSignal?.aborted;
      expertRecord.status = isAbort ? 'stopped' : 'failed';
      expertRecord.error = err?.message || 'Expert failed';
      store.saveExpert(sessionId, expertRecord);
      emitEvent({
        type: 'expert_event',
        sessionId,
        expertId,
        status: expertRecord.status,
        role,
        model,
        action: expertRecord.status,
        error: expertRecord.error,
      });
      return `[Expert ${role} (${expertId}) — ${expertRecord.status}]: ${expertRecord.error}`;
    } finally {
      runtime.activeExperts.delete(expertId);
      broadcastSession(sessionId);
    }
  }

  async function notifySubordinateFromCoordinator(sessionId, noticeText) {
    const runtime = getRuntime(sessionId);
    runtime.subordinateQueue = runtime.subordinateQueue
      .catch(() => {})
      .then(async () => {
        const session = store.getSession(sessionId);
        if (!session) return;
        const msg = store.appendMessage(sessionId, {
          role: 'user',
          internalNotice: true,
          content: noticeText,
        });
        emitEvent({ type: 'message_added', sessionId, message: msg });
        await runSubordinateTurn(sessionId);
      });
    return runtime.subordinateQueue;
  }

  async function runCoordinatorLoop(sessionId) {
    const runtime = getRuntime(sessionId);
    const ac = new AbortController();
    runtime.coordinatorAbort = ac;
    runtime.pauseRequested = false;

    const settings = store.getSettings();
    const shell = detectDefaultShell(settings.shell);

    let coord = store.getCoordinator(sessionId);
    coord.status = 'running';
    coord.lastError = null;
    store.saveCoordinator(sessionId, coord);
    emitEvent({ type: 'coordinator_event', sessionId, action: 'status', status: 'running' });
    broadcastSession(sessionId);

    let consecutiveTextOnly = 0;
    let lastErrorKey = '';
    let sameErrorCount = 0;
    let completionPayload = null;
    let escalationPayload = null;

    let needsWatchdogRecovery = null;

    try {
      while (true) {
        const session = store.getSession(sessionId);
        if (!session) break;
        if (ac.signal.aborted) {
          coord.status = 'stopped';
          store.saveCoordinator(sessionId, coord);
          store.updateSession(sessionId, { phase: 'stopped' });
          break;
        }
        if (runtime.pauseRequested) {
          coord.status = 'paused';
          store.saveCoordinator(sessionId, coord);
          store.updateSession(sessionId, { phase: 'paused' });
          break;
        }
        if (session.uninterruptedMode === false && (coord.turnCount || 0) >= (session.maxTurns || 100)) {
          coord.status = 'paused';
          coord.lastError = `Reached maxTurns limit (${session.maxTurns || 100}). Click Resume to continue.`;
          store.saveCoordinator(sessionId, coord);
          store.updateSession(sessionId, { phase: 'paused', lastError: coord.lastError });
          break;
        }

        // Flush any queued directives from Subordinate cleanly at turn boundary
        while (runtime.directiveQueue.length > 0) {
          const directive = runtime.directiveQueue.shift();
          coord.directives = [...(coord.directives || []), directive];
          coord.messages.push({
            role: 'user',
            content: `[Relayed Directive from Subordinate (${directive.priority || 'normal'})]\n${directive.instructions}`,
          });
          store.saveCoordinator(sessionId, coord);
          emitEvent({ type: 'coordinator_event', sessionId, action: 'directive', directive });
        }

        const { provider, model } = resolveProviderAndModel(session, 'coordinator');
        const systemPrompt = buildBootstrapPrompt({
          skillsRoot,
          tier: 'coordinator',
          phase: 'running',
          rules: session.rules,
          plan: session.plan,
          pinnedSkills: session.pinnedSkills,
          enabledSkillPacks: session.enabledSkillPacks,
          shellName: shell.displayName,
          effectiveWorkDir: session.effectiveWorkDir,
          expertRoster: getSessionActiveExperts(session),
        });

        const tools = getToolDefinitions({ tier: 'coordinator', phase: 'running' });
        const executor = createToolExecutor({
          store,
          skillsRoot,
          session,
          effectiveWorkDir: session.effectiveWorkDir,
          signal: ac.signal,
          shellOverride: settings.shell,
          allowedTools: new Set(tools.map((t) => t.name)),
          callbacks: {
            onVisualScreen: (filename) => {
              emitEvent({ type: 'companion_reload', sessionId, filename });
            },
            onSpawnExpert: (args) => runExpert({ sessionId, args, parentSignal: ac.signal, depth: 1 }),
            onUpdateTaskProgress: (args) => updateTaskProgress(sessionId, args),
            onEscalate: ({ question, context }) => {
              escalationPayload = { question, context };
              return 'Escalation sent to Subordinate. Pausing Coordinator until human partner responds.';
            },
            onReportComplete: ({ summary, verification }) => {
              const latestSession = store.getSession(sessionId);
              if (latestSession?.uninterruptedMode !== false) {
                const incomplete = (latestSession.tasks || []).filter(
                  (t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked'
                );
                if (incomplete.length > 0) {
                  const list = incomplete.map((t) => `${t.id} (${t.title} — ${t.status})`).join('; ');
                  return {
                    ok: false,
                    output: `Cannot complete yet — incomplete tasks remain: ${list}. Finish and verify all remaining tasks and mark each 'done' via update_task_progress before calling report_complete.`,
                  };
                }
              }
              completionPayload = { summary, verification };
              return 'Completion report sent to Subordinate.';
            },
          },
        });

        coord.turnCount = (coord.turnCount || 0) + 1;
        store.saveCoordinator(sessionId, coord);
        store.updateSession(sessionId, { turnCount: coord.turnCount });

        const reply = await callModelWithOverflowRetry({
          sessionId,
          provider,
          model,
          systemPrompt,
          messages: coord.messages,
          tools,
          signal: ac.signal,
          onText: (delta) => emitEvent({ type: 'coordinator_event', sessionId, action: 'delta', delta }),
          onReasoning: (delta) => emitEvent({ type: 'coordinator_event', sessionId, action: 'reasoning', delta }),
        });

        coord.messages.push({
          role: 'assistant',
          content: reply.content || '',
          reasoning: reply.reasoning || '',
          toolCalls: reply.toolCalls || [],
        });
        store.saveCoordinator(sessionId, coord);
        emitEvent({
          type: 'coordinator_event',
          sessionId,
          action: 'message',
          message: coord.messages[coord.messages.length - 1],
          turnCount: coord.turnCount,
        });

        if (!reply.toolCalls || reply.toolCalls.length === 0) {
          consecutiveTextOnly++;
          if (consecutiveTextOnly >= 3) {
            if (session.uninterruptedMode !== false && runtime.consecutiveRecoveries < 5) {
              needsWatchdogRecovery = {
                reason: `Coordinator stalled with 3 consecutive text-only turns. Latest Coordinator message:\n${reply.content || '(empty)'}`,
                fallbackDirective: 'Stop narrating without tool calls. Execute the next incomplete task using tools or spawn_expert, mark finished tasks done via update_task_progress, and call report_complete once 100% done.',
              };
              break;
            }
            coord.status = 'paused';
            store.saveCoordinator(sessionId, coord);
            store.updateSession(sessionId, { phase: 'paused' });
            notifySubordinateFromCoordinator(
              sessionId,
              `[System Update] Coordinator paused after 3 consecutive text-only turns. Latest Coordinator message:\n${reply.content || '(empty)'}`
            ).catch(() => {});
            break;
          }
          coord.messages.push({
            role: 'user',
            content: 'Continue executing the approved plan using tools (or spawn_expert), call escalate_to_subordinate if you need a human decision, or call report_complete once verified.',
          });
          store.saveCoordinator(sessionId, coord);
          continue;
        }

        consecutiveTextOnly = 0;

        // Execute tool calls in this turn — parallel for spawn_expert batches, sequential otherwise
        const allSpawnExperts = reply.toolCalls.length > 1 && reply.toolCalls.every((tc) => tc.name === 'spawn_expert');
        const executed = [];
        if (allSpawnExperts) {
          coord.currentTool = `spawn_expert (${reply.toolCalls.length} parallel)`;
          store.saveCoordinator(sessionId, coord);
          const parallel = await Promise.all(
            reply.toolCalls.map(async (tc) => {
              emitEvent({ type: 'coordinator_event', sessionId, action: 'tool_call', toolCall: tc });
              const res = await executor.execute(tc.name, tc.arguments);
              emitEvent({ type: 'coordinator_event', sessionId, action: 'tool_result', toolCallId: tc.id, name: tc.name, result: res });
              return { tc, res };
            })
          );
          coord.currentTool = null;
          executed.push(...parallel);
        } else {
          for (const tc of reply.toolCalls) {
            coord.currentTool = tc.name;
            store.saveCoordinator(sessionId, coord);
            emitEvent({ type: 'coordinator_event', sessionId, action: 'tool_call', toolCall: tc });
            const res = await executor.execute(tc.name, tc.arguments);
            coord.currentTool = null;
            emitEvent({ type: 'coordinator_event', sessionId, action: 'tool_result', toolCallId: tc.id, name: tc.name, result: res });
            executed.push({ tc, res });
          }
        }

        const coordVisualAttachments = [];
        for (const { tc, res } of executed) {
          coord.messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: res.output,
          });
          if (res.imageAttachment) coordVisualAttachments.push(res.imageAttachment);
          if (!res.ok) {
            const key = `${tc.name}::${res.output.slice(0, 120)}`;
            if (key === lastErrorKey) sameErrorCount++;
            else { lastErrorKey = key; sameErrorCount = 1; }
          } else {
            lastErrorKey = '';
            sameErrorCount = 0;
            runtime.consecutiveRecoveries = 0;
          }
        }
        if (coordVisualAttachments.length > 0 && !completionPayload && !escalationPayload) {
          coord.messages.push({
            role: 'user',
            content: `Visual inspection of workspace image(s): ${coordVisualAttachments.map((a) => a.filename).join(', ')}. Critique visual quality, anatomical alignment, and defects honestly before continuing.`,
            attachments: coordVisualAttachments,
          });
        }
        store.saveCoordinator(sessionId, coord);

        if (completionPayload) {
          coord.status = 'completed';
          store.saveCoordinator(sessionId, coord);
          try {
            await notifySubordinateFromCoordinator(
              sessionId,
              `[System Update] Coordinator reported completion.\nSummary:\n${completionPayload.summary}\n\nVerification:\n${completionPayload.verification}\n\nPresent a clear, concise summary to your human partner.`
            );
          } catch (subErr) {
            store.appendMessage(sessionId, {
              role: 'system',
              content: `Coordinator completed (${completionPayload.summary}), but Subordinate summary failed: ${subErr.message}`,
            });
          }
          store.updateSession(sessionId, { phase: 'completed', lastError: null });
          broadcastSession(sessionId);
          break;
        }

        if (escalationPayload) {
          coord.status = 'paused';
          store.saveCoordinator(sessionId, coord);
          try {
            await notifySubordinateFromCoordinator(
              sessionId,
              `[System Update] Coordinator escalated a blocking question and paused:\nQuestion: ${escalationPayload.question}\nContext: ${escalationPayload.context || 'none'}\n\nAsk your human partner clearly and relay their answer back to the Coordinator once they reply.`
            );
          } catch (subErr) {
            store.appendMessage(sessionId, {
              role: 'system',
              content: `Coordinator escalated ("${escalationPayload.question}"), but Subordinate notification failed: ${subErr.message}`,
            });
          }
          store.updateSession(sessionId, { phase: 'paused' });
          broadcastSession(sessionId);
          break;
        }

        if (sameErrorCount >= 5) {
          if (session.uninterruptedMode !== false && runtime.consecutiveRecoveries < 5) {
            needsWatchdogRecovery = {
              reason: `Coordinator hit 5 consecutive identical tool errors (${lastErrorKey}).`,
              fallbackDirective: `You hit repeated identical tool errors (${lastErrorKey}). Stop repeating the same failing call: inspect the root cause, spawn a 'debugger' expert if needed, and try a different approach to complete the remaining tasks.`,
            };
            break;
          }
          coord.status = 'paused';
          coord.lastError = `Paused after 5 consecutive identical tool errors (${lastErrorKey}).`;
          store.saveCoordinator(sessionId, coord);
          store.updateSession(sessionId, { phase: 'paused', lastError: coord.lastError });
          break;
        }
      }
    } catch (err) {
      const isAbort = err?.name === 'AbortError' || ac.signal.aborted;
      const isPermanentAuth = err?.status === 401 || err?.status === 403;
      const sNow = store.getSession(sessionId);
      if (!isAbort && !isPermanentAuth && !runtime.pauseRequested && sNow?.uninterruptedMode !== false && runtime.consecutiveRecoveries < 5) {
        needsWatchdogRecovery = {
          reason: `Coordinator hit a transient/recoverable error: ${err?.message || 'unknown error'}`,
          fallbackDirective: `Recovering from transient error (${err?.message || 'error'}). Continue executing the remaining incomplete tasks cleanly.`,
        };
      } else {
        const nextStatus = isAbort ? 'stopped' : 'failed';
        coord.status = nextStatus;
        coord.lastError = isAbort ? null : (err?.message || 'Coordinator failed');
        store.saveCoordinator(sessionId, coord);
        store.updateSession(sessionId, { phase: nextStatus, lastError: coord.lastError });
        emitEvent({ type: 'error', sessionId, source: 'coordinator', message: err?.message || 'Coordinator error' });
      }
    } finally {
      runtime.coordinatorAbort = null;
      runtime.coordinatorPromise = null;
      if (!needsWatchdogRecovery) {
        emitEvent({ type: 'coordinator_event', sessionId, action: 'status', status: coord.status });
        broadcastSession(sessionId);
      }
    }

    // Autonomous Supervisor Watchdog recovery (runs outside finally so coordinatorPromise is cleanly released!)
    if (needsWatchdogRecovery && !runtime.pauseRequested) {
      runtime.consecutiveRecoveries++;
      const sNow = store.getSession(sessionId);
      if (sNow && sNow.phase !== 'stopped' && sNow.phase !== 'completed') {
        const remaining = (sNow.tasks || [])
          .filter((t) => t.status !== 'done')
          .map((t) => `${t.id}: ${t.title} (${t.status})`)
          .join(', ');
        const notice = `[Supervisor Watchdog — Auto-Recovery #${runtime.consecutiveRecoveries}/5]\n${needsWatchdogRecovery.reason}\nRemaining tasks: ${remaining || 'check plan'}\nDiagnose the issue and call relay_to_coordinator with a concrete recovery directive so execution continues until 100% complete.`;
        let relayedBySub = false;
        const beforeQueueLen = runtime.directiveQueue.length;
        try {
          await notifySubordinateFromCoordinator(sessionId, notice);
          relayedBySub = Boolean(runtime.coordinatorPromise) || runtime.directiveQueue.length > beforeQueueLen;
        } catch { /* fall through to direct recovery directive */ }

        const latest = store.getSession(sessionId);
        if (!runtime.pauseRequested && latest && latest.phase !== 'stopped' && latest.phase !== 'completed') {
          if (!relayedBySub) {
            runtime.directiveQueue.push({
              instructions: needsWatchdogRecovery.fallbackDirective,
              priority: 'urgent',
              timestamp: new Date().toISOString(),
            });
          }
          if (!runtime.coordinatorPromise) {
            store.updateSession(sessionId, { phase: 'running', lastError: null });
            startCoordinatorBackground(sessionId);
          }
        }
      }
    }
  }

  function startCoordinatorBackground(sessionId) {
    const runtime = getRuntime(sessionId);
    if (runtime.coordinatorPromise) return runtime.coordinatorPromise;
    runtime.coordinatorPromise = runCoordinatorLoop(sessionId);
    return runtime.coordinatorPromise;
  }

  async function runSubordinateTurn(sessionId) {
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const settings = store.getSettings();
    const shell = detectDefaultShell(settings.shell);

    let statusChecksInTurn = 0;
    for (let step = 0; step < MAX_SUBORDINATE_TOOL_STEPS; step++) {
      const freshSession = store.getSession(sessionId);
      const { provider, model } = resolveProviderAndModel(freshSession, 'subordinate');
      const systemPrompt = buildBootstrapPrompt({
        skillsRoot,
        tier: 'subordinate',
        phase: freshSession.phase,
        rules: freshSession.rules,
        plan: freshSession.plan,
        pinnedSkills: freshSession.pinnedSkills,
        enabledSkillPacks: freshSession.enabledSkillPacks,
        shellName: shell.displayName,
        effectiveWorkDir: freshSession.effectiveWorkDir,
      });

      const tools = getToolDefinitions({ tier: 'subordinate', phase: freshSession.phase });
      const allowedTools = new Set(tools.map((t) => t.name));
      const executor = createToolExecutor({
        store,
        skillsRoot,
        session: freshSession,
        effectiveWorkDir: freshSession.effectiveWorkDir,
        shellOverride: settings.shell,
        allowedTools,
        callbacks: {
          onVisualScreen: (filename) => {
            emitEvent({ type: 'companion_reload', sessionId, filename });
          },
          onProposeRules: ({ rulesMarkdown, planMarkdown }) => {
            store.updateSession(sessionId, {
              rules: rulesMarkdown,
              plan: planMarkdown,
              phase: 'ready',
              suggestedActions: [
                { label: 'Approve & Dispatch to Coordinator', kind: 'approve', style: 'success' },
                { label: 'Request Plan Changes', kind: 'reply', value: 'Let us adjust the rules/plan before dispatching.', style: 'secondary' },
              ],
            });
            broadcastSession(sessionId);
            return 'Saved rules and plan. Session is now READY for human partner approval.';
          },
          onOfferActions: (actions) => {
            const validKinds = new Set(['reply', 'approve', 'relay', 'pause', 'resume']);
            const validStyles = new Set(['primary', 'success', 'secondary', 'warn']);
            const cleaned = (actions || [])
              .filter((a) => a && typeof a.label === 'string' && validKinds.has(a.kind))
              .slice(0, 6)
              .map((a) => ({
                label: a.label.trim().slice(0, 80),
                kind: a.kind,
                value: a.value !== undefined ? String(a.value) : a.label.trim(),
                style: validStyles.has(a.style) ? a.style : 'secondary',
              }));
            store.updateSession(sessionId, { suggestedActions: cleaned });
            broadcastSession(sessionId);
            return `Rendered ${cleaned.length} clickable action button(s).`;
          },
          onRelayToCoordinator: async ({ instructions, priority }) => {
            const runtime = getRuntime(sessionId);
            runtime.directiveQueue.push({
              instructions,
              priority: priority || 'normal',
              timestamp: new Date().toISOString(),
            });
            const coord = store.getCoordinator(sessionId);
            if (coord.status !== 'running') {
              const s = store.getSession(sessionId);
              runtime.consecutiveRecoveries = 0;
      const ws = await prepareSessionWorkspace({
                session: s,
                activeSessions: store.listSessions(),
                dataDir: store.dataDir,
              });
              const currentMax = s.maxTurns || 100;
              const nextMaxTurns = (coord.turnCount || 0) >= currentMax ? (coord.turnCount || 0) + 100 : currentMax;
              store.updateSession(sessionId, {
                effectiveWorkDir: ws.effectiveWorkDir,
                worktreeBranch: ws.worktreeBranch,
                maxTurns: nextMaxTurns,
                phase: 'running',
                lastError: null,
              });
              startCoordinatorBackground(sessionId);
              return 'Relayed directive and started/resumed Coordinator.';
            }
            return 'Directive queued for Coordinator at its next turn boundary.';
          },
          onGetCoordinatorStatus: () => {
            statusChecksInTurn++;
            if (statusChecksInTurn > 1) {
              return 'Status was already checked in this turn. Do NOT call get_coordinator_status again — summarize the status concisely for your human partner now.';
            }
            const coord = store.getCoordinator(sessionId);
            const experts = store.listExperts(sessionId).map((e) => ({
              id: e.id,
              role: e.role,
              status: e.status,
              model: e.model,
            }));
            const recent = (coord.messages || []).slice(-4).map((m) => ({
              role: m.role,
              content: String(m.content || '').slice(0, 300),
              tools: (m.toolCalls || []).map((tc) => tc.name),
            }));
            return {
              status: coord.status,
              turnCount: coord.turnCount,
              lastError: coord.lastError,
              experts,
              recent,
            };
          },
          onPauseCoordinator: async () => {
            await pauseSession(sessionId);
            return 'Coordinator paused.';
          },
          onResumeCoordinator: async (guidance) => {
            if (guidance) {
              getRuntime(sessionId).directiveQueue.push({
                instructions: guidance,
                priority: 'normal',
                timestamp: new Date().toISOString(),
              });
            }
            await resumeSession(sessionId);
            return 'Coordinator resumed.';
          },
        },
      });

      const messages = store.getMessages(sessionId);
      const reply = await callModelWithOverflowRetry({
        sessionId,
        provider,
        model,
        systemPrompt,
        messages,
        tools,
        onText: (delta) => emitEvent({ type: 'message_delta', sessionId, delta }),
        onReasoning: (delta) => emitEvent({ type: 'reasoning_delta', sessionId, delta }),
      });

      const assistantMsg = store.appendMessage(sessionId, {
        role: 'assistant',
        content: reply.content || '',
        reasoning: reply.reasoning || '',
        toolCalls: reply.toolCalls || [],
      });
      emitEvent({ type: 'message_added', sessionId, message: assistantMsg });

      if (!reply.toolCalls || reply.toolCalls.length === 0) {
        break;
      }

      const subVisualAttachments = [];
      let stopSubPolling = false;
      for (const tc of reply.toolCalls) {
        emitEvent({ type: 'tool_call', sessionId, toolCall: tc });
        const res = await executor.execute(tc.name, tc.arguments);
        if (tc.name === 'get_coordinator_status' && statusChecksInTurn > 1) {
          stopSubPolling = true;
        }
        emitEvent({ type: 'tool_result', sessionId, toolCallId: tc.id, name: tc.name, result: res });
        const toolMsg = store.appendMessage(sessionId, {
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          content: res.output,
        });
        emitEvent({ type: 'message_added', sessionId, message: toolMsg });
        if (res.imageAttachment) subVisualAttachments.push(res.imageAttachment);
      }
      if (stopSubPolling) {
        break;
      }
      if (subVisualAttachments.length > 0) {
        const visMsg = store.appendMessage(sessionId, {
          role: 'user',
          internalNotice: true,
          content: `Loaded workspace image(s) for visual inspection: ${subVisualAttachments.map((a) => a.filename).join(', ')}.`,
          attachments: subVisualAttachments,
        });
        emitEvent({ type: 'message_added', sessionId, message: visMsg });
      }
    }
    return broadcastSession(sessionId);
  }

  async function sendUserMessage(sessionId, text, attachments = []) {
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const expanded = expandSlashSkill(text);
    const runtime = getRuntime(sessionId);

    const p = runtime.subordinateQueue
      .catch(() => {})
      .then(async () => {
        store.updateSession(sessionId, { suggestedActions: [] });
        const userMsg = store.appendMessage(sessionId, {
          role: 'user',
          content: expanded,
          displayText: text,
          attachments: Array.isArray(attachments) ? attachments : [],
        });
        emitEvent({ type: 'message_added', sessionId, message: userMsg });
        return await runSubordinateTurn(sessionId);
      });
    runtime.subordinateQueue = p;
    return await p;
  }

  async function approveAndRun(sessionId, { rules, plan, allowSharedNonGit = false } = {}) {
    return await withWorkspaceLock(async () => {
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (session.phase === 'running' || getRuntime(sessionId).coordinatorPromise) {
        const err = new Error('Session Coordinator is already running.');
        err.code = 'ALREADY_RUNNING';
        err.status = 409;
        throw err;
      }

      getRuntime(sessionId).consecutiveRecoveries = 0;
      const ws = await prepareSessionWorkspace({
        session,
        activeSessions: store.listSessions(),
        dataDir: store.dataDir,
      });
      if (ws.warning && !allowSharedNonGit) {
        const err = new Error(ws.warning);
        err.code = 'WORKSPACE_CONFLICT';
        throw err;
      }

      let lockedRules = (rules !== undefined ? rules : session.rules) || '';
      let lockedPlan = (plan !== undefined ? plan : session.plan) || '';
      if (!lockedPlan.trim()) {
        const fallback = extractFallbackPlanFromMessages(store.getMessages(sessionId));
        if (fallback) lockedPlan = fallback;
      }
      if (!lockedRules.trim() && lockedPlan.trim()) {
        lockedRules = 'Follow all constraints and goals agreed in the interview and approved plan.';
      }

      const parsedTasks = parsePlanTasks(lockedPlan);
      const nextTasks = parsedTasks.length > 0 ? parsedTasks : (session.tasks || []);
      const attachments = store.listAttachments(sessionId);

      const updated = store.updateSession(sessionId, {
        rules: lockedRules,
        plan: lockedPlan,
        tasks: nextTasks,
        suggestedActions: [],
        startedAt: session.startedAt || new Date().toISOString(),
        effectiveWorkDir: ws.effectiveWorkDir,
        worktreeBranch: ws.worktreeBranch,
        phase: 'running',
        lastError: null,
      });

      const taskListText = nextTasks.length > 0
        ? `\nMission Board Tasks (update via update_task_progress):\n${nextTasks.map((t) => `- ${t.id}: ${t.title}`).join('\n')}`
        : '';
      const attListText = attachments.length > 0
        ? `\nUploaded Reference Images (copy with save_attachment_to_workspace):\n${attachments.map((a) => `- ${a.id}: ${a.filename} (${a.mimeType})`).join('\n')}`
        : '';

      const coord = store.getCoordinator(sessionId);
      coord.messages = coord.messages || [];
      coord.messages.push({
        role: 'user',
        content: [
          `[Mission Approved & Dispatched by Subordinate]`,
          `Session: ${updated.title}`,
          `Workspace: ${updated.effectiveWorkDir}${updated.worktreeBranch ? ` (isolated git worktree branch: ${updated.worktreeBranch})` : ''}`,
          lockedRules ? `\nLocked Rules:\n${lockedRules}` : '',
          lockedPlan ? `\nApproved Plan:\n${lockedPlan}` : '',
          taskListText,
          attListText,
          '\nExecute this mission autonomously, keeping the Mission Board updated via update_task_progress, coordinating specialist Experts via spawn_expert, verifying all outputs, and calling report_complete when done.',
        ].join('\n'),
      });
      coord.directives = [
        ...(coord.directives || []),
        { instructions: 'Initial approved mission dispatch', priority: 'normal', timestamp: new Date().toISOString() },
      ];
      store.saveCoordinator(sessionId, coord);

      const sysMsg = store.appendMessage(sessionId, {
        role: 'system',
        content: `Rules locked and mission dispatched to Coordinator${updated.worktreeBranch ? ` (isolated branch: ${updated.worktreeBranch})` : ''}. You can keep chatting with Subordinate anytime for updates or course corrections.`,
      });
      emitEvent({ type: 'message_added', sessionId, message: sysMsg });

      startCoordinatorBackground(sessionId);
      return broadcastSession(sessionId);
    });
  }

  async function reopenInterview(sessionId) {
    await pauseSession(sessionId);
    const runtime = getRuntime(sessionId);
    if (runtime.coordinatorPromise) {
      await runtime.coordinatorPromise.catch(() => {});
    }
    store.updateSession(sessionId, { phase: 'interview' });
    const msg = store.appendMessage(sessionId, {
      role: 'system',
      content: 'Re-opened Interview phase. Rules & Plan can now be edited before re-dispatching to the Coordinator.',
    });
    emitEvent({ type: 'message_added', sessionId, message: msg });
    return broadcastSession(sessionId);
  }

  async function pauseSession(sessionId) {
    const runtime = getRuntime(sessionId);
    runtime.pauseRequested = true;
    const session = store.getSession(sessionId);
    if (!session) return null;
    if (session.phase === 'running' && !runtime.coordinatorPromise) {
      store.updateSession(sessionId, { phase: 'paused' });
      store.saveCoordinator(sessionId, { status: 'paused' });
    }
    return broadcastSession(sessionId);
  }

  async function resumeSession(sessionId) {
    const runtime = getRuntime(sessionId);
    if (runtime.coordinatorPromise && runtime.pauseRequested) {
      await runtime.coordinatorPromise.catch(() => {});
    }
    return await withWorkspaceLock(async () => {
      const session = store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (runtime.coordinatorPromise) {
        runtime.pauseRequested = false;
        return broadcastSession(sessionId);
      }
      runtime.consecutiveRecoveries = 0;
      const ws = await prepareSessionWorkspace({
        session,
        activeSessions: store.listSessions(),
        dataDir: store.dataDir,
      });
      const coord = store.getCoordinator(sessionId);
      const currentMax = session.maxTurns || 100;
      const nextMaxTurns = (coord.turnCount || 0) >= currentMax ? (coord.turnCount || 0) + 100 : currentMax;
      store.updateSession(sessionId, {
        effectiveWorkDir: ws.effectiveWorkDir,
        worktreeBranch: ws.worktreeBranch,
        maxTurns: nextMaxTurns,
        phase: 'running',
        lastError: null,
      });
      startCoordinatorBackground(sessionId);
      return broadcastSession(sessionId);
    });
  }

  async function stopSession(sessionId) {
    const runtime = getRuntime(sessionId);
    runtime.pauseRequested = true;
    if (runtime.coordinatorAbort) {
      runtime.coordinatorAbort.abort();
    }
    if (runtime.coordinatorPromise) {
      await runtime.coordinatorPromise.catch(() => {});
    }
    const session = store.getSession(sessionId);
    if (!session) return null;
    store.updateSession(sessionId, { phase: 'stopped' });
    store.saveCoordinator(sessionId, { status: 'stopped' });
    return broadcastSession(sessionId);
  }

  function setPinnedSkills(sessionId, skillNames) {
    const clean = Array.isArray(skillNames) ? [...new Set(skillNames.map(String))] : [];
    store.updateSession(sessionId, { pinnedSkills: clean });
    return broadcastSession(sessionId);
  }

  async function relayDirect(sessionId, instructions, priority = 'normal') {
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const text = String(instructions || '').trim();
    if (!text) throw new Error('instructions are required');
    const runtime = getRuntime(sessionId);
    runtime.directiveQueue.push({
      instructions: text,
      priority: priority || 'normal',
      timestamp: new Date().toISOString(),
    });

    const sysMsg = store.appendMessage(sessionId, {
      role: 'system',
      content: `Relayed directive directly to Coordinator (${priority || 'normal'}): ${text.slice(0, 300)}`,
    });
    emitEvent({ type: 'message_added', sessionId, message: sysMsg });

    const coord = store.getCoordinator(sessionId);
    if (coord.status !== 'running' && session.phase !== 'interview' && session.phase !== 'ready') {
      await resumeSession(sessionId);
    }
    return broadcastSession(sessionId);
  }

  return {
    sendUserMessage,
    approveAndRun,
    relayDirect,
    reopenInterview,
    pauseSession,
    resumeSession,
    stopSession,
    setPinnedSkills,
    buildPromptWindow,
  };
}
