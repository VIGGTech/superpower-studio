const state = {
  providers: [],
  expertsRoster: [],
  skills: [],
  sessions: [],
  defaultWorkspace: '',
  activeSessionId: null,
  activeDetail: null,
  selectedProviderId: null,
  selectedExpertId: null,
  streamingText: '',
  streamingReasoning: '',
  subordinateBusy: false,
  coordLiveText: '',
  expertLiveText: {}, // { [expertId]: string }
  pendingAttachments: [], // [{ id, filename, mimeType, previewUrl }]
  loadedCompanionSessionId: null,
  selectedScreen: null,
  visualMode: 'screens', // 'screens' | 'files'
  workspaceImages: [],
  wsReconnectDelay: 1000,
  wsHasConnectedOnce: false,
  ws: null,
  ui: {
    showCompletedExperts: false,
    showDoneTasks: false,
    showDirectives: false,
    showCoordTrace: false,
  },
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function showToast(message, kind = 'info', durationMs = 5000) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = String(message);
  stack.appendChild(el);
  setTimeout(() => { el.remove(); }, durationMs);
}

function showSessionError(message) {
  const banner = $('#session-error-banner');
  if (!message) {
    banner.classList.add('hidden');
    return;
  }
  $('#session-error-text').textContent = String(message);
  banner.classList.remove('hidden');
}

function showConfirmDialog(title, message) {
  return new Promise((resolve) => {
    const modal = $('#modal-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    modal.classList.remove('hidden');
    const cleanup = (val) => {
      modal.classList.add('hidden');
      $('#confirm-ok').onclick = null;
      $('#confirm-cancel').onclick = null;
      resolve(val);
    };
    $('#confirm-ok').onclick = () => cleanup(true);
    $('#confirm-cancel').onclick = () => cleanup(false);
  });
}

function renderMarkdown(md) {
  const safe = escapeHtml(md || '');
  const blocks = [];
  let text = safe.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `@@CODEBLOCK_${idx}@@`;
  });
  text = text
    .replace(/^### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^## (.*)$/gm, '<h3>$1</h3>')
    .replace(/^# (.*)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
  for (let i = 0; i < blocks.length; i++) {
    text = text.replace(`@@CODEBLOCK_${i}@@`, blocks[i]);
  }
  return text;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Strip ?token=... from address bar after cookie is set
if (window.location.search.includes('token=')) {
  try { window.history.replaceState({}, '', '/'); } catch { /* ignore */ }
}

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.addEventListener('open', () => {
    $('#ws-dot').classList.add('online');
    state.wsReconnectDelay = 1000;
    if (state.wsHasConnectedOnce) {
      refreshSessions().catch(() => {});
      if (state.activeSessionId) loadSessionDetail(state.activeSessionId).catch(() => {});
    }
    state.wsHasConnectedOnce = true;
  });
  ws.addEventListener('close', () => {
    $('#ws-dot').classList.remove('online');
    const delay = state.wsReconnectDelay;
    state.wsReconnectDelay = Math.min(15000, Math.round(state.wsReconnectDelay * 1.7));
    setTimeout(connectWebSocket, delay);
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWsEvent(msg);
  });
}

function handleWsEvent(ev) {
  if (ev.type === 'session_updated' || ev.type === 'session_deleted') {
    refreshSessions().catch(() => {});
    if (ev.sessionId === state.activeSessionId) {
      if (ev.type === 'session_deleted') {
        state.activeSessionId = null;
        state.activeDetail = null;
        renderMain();
      } else {
        loadSessionDetail(ev.sessionId, { timeline: false });
      }
    }
    return;
  }

  if (ev.sessionId !== state.activeSessionId) return;

  if (ev.type === 'message_delta') {
    state.streamingText += ev.delta || '';
    renderStreaming();
  } else if (ev.type === 'reasoning_delta') {
    state.streamingReasoning += ev.delta || '';
    renderStreaming();
  } else if (ev.type === 'message_added') {
    if (ev.message?.role === 'assistant') {
      state.streamingText = '';
      state.streamingReasoning = '';
      renderStreaming();
    }
    loadSessionDetail(ev.sessionId, { timeline: true });
  } else if (ev.type === 'coordinator_event') {
    if (ev.action === 'delta') {
      state.coordLiveText += ev.delta || '';
      const el = $('#coord-live-stream');
      if (el) {
        el.textContent = state.coordLiveText.slice(-500);
        el.classList.remove('hidden');
      }
    } else {
      state.coordLiveText = '';
      loadSessionDetail(ev.sessionId, { timeline: false });
    }
  } else if (ev.type === 'expert_event') {
    if (ev.action === 'delta' || ev.action === 'reasoning') {
      const prev = state.expertLiveText[ev.expertId] || '';
      const next = (prev + (ev.delta || '')).slice(-600);
      state.expertLiveText[ev.expertId] = next;
      const nodeEl = document.querySelector(`[data-expert-live="${ev.expertId}"]`);
      if (nodeEl) {
        nodeEl.textContent = next;
        nodeEl.classList.remove('hidden');
      }
    } else {
      if (ev.action === 'completed' || ev.action === 'failed' || ev.action === 'stopped') {
        delete state.expertLiveText[ev.expertId];
      }
      loadSessionDetail(ev.sessionId, { timeline: false });
    }
  } else if (ev.type === 'companion_reload') {
    if (state.activeDetail && ev.filename) state.activeDetail.latestScreen = ev.filename;
    state.selectedScreen = ev.filename || null;
    loadSessionDetail(ev.sessionId, { timeline: false });
    reloadCompanionFrame(ev.filename);
    refreshWorkspaceImages().catch(() => {});
    showToast(`Visual Companion updated: ${ev.filename || 'new screen'}`, 'info', 3000);
  } else if (ev.type === 'companion_event') {
    const choice = ev.event?.choice || ev.event?.text || '';
    if (choice) {
      const bar = $('#companion-choice-bar');
      bar.textContent = `Visual Companion click recorded: "${choice}"`;
      bar.classList.remove('hidden');
    }
  } else if (ev.type === 'error') {
    showSessionError(`${ev.source || 'Studio'}: ${ev.message}`);
    showToast(`${ev.source || 'Studio'} error: ${ev.message}`, 'error', 7000);
  }
}

// Live 1s elapsed timer ticker while Coordinator is running
setInterval(() => {
  const s = state.activeDetail?.session;
  if (!s || s.phase !== 'running' || !s.startedAt) return;
  const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(s.startedAt)) / 1000));
  const el = $('#mission-elapsed');
  if (el) el.textContent = `Elapsed: ${formatDuration(elapsed)}`;
}, 1000);

function renderStreaming() {
  const box = $('#streaming-box');
  if (!state.streamingText && !state.streamingReasoning) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const rEl = $('#streaming-reasoning');
  if (state.streamingReasoning) {
    rEl.textContent = state.streamingReasoning;
    rEl.classList.remove('hidden');
  } else {
    rEl.classList.add('hidden');
  }
  $('#streaming-text').innerHTML = renderMarkdown(state.streamingText);
  const tl = $('#timeline');
  tl.scrollTop = tl.scrollHeight;
}

async function bootstrap() {
  const [provRes, expRes, skillRes, setRes, sessRes] = await Promise.all([
    api('/api/providers'),
    api('/api/experts'),
    api('/api/skills'),
    api('/api/settings'),
    api('/api/sessions'),
  ]);
  state.providers = provRes.providers || [];
  state.expertsRoster = expRes.experts || [];
  state.skills = skillRes.skills || [];
  state.defaultWorkspace = setRes.defaultWorkspace || '';
  state.versionInfo = setRes.versionInfo || null;
  state.sessions = sessRes.sessions || [];
  $('#btn-experts').textContent = `Expert Roster (${state.expertsRoster.length})`;
  renderVersionBadges(state.versionInfo);

  renderSessionList();
  renderSkillsTab();
  if (state.sessions.length > 0 && !state.activeSessionId) {
    await selectSession(state.sessions[0].id);
  } else {
    renderMain();
  }
}

function renderVersionBadges(v) {
  if (!v) return;
  const repoUrl = v.repository || 'https://github.com/VIGGTech/superpower-studio';
  const upstreamUrl = v.upstream?.url || 'https://github.com/obra/superpowers';
  const sub = $('#brand-version-sub');
  if (sub) {
    sub.textContent = `${v.publisher || 'VIGGTech'} v${v.version}`;
    sub.title = `${v.productName} (${v.edition}) v${v.version} — ${v.license} Open Source, derived from ${upstreamUrl} v${v.upstream?.version || '7.0.2'}`;
  }
  const repoLink = $('#brand-repo-link');
  if (repoLink) {
    repoLink.href = repoUrl;
    repoLink.title = repoUrl;
  }
  const emptyNote = $('#empty-version-note');
  if (emptyNote) {
    emptyNote.innerHTML = `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(v.edition || 'VIGGTech Edition')} v${escapeHtml(v.version)}</a> (${escapeHtml(v.license || 'MIT')} Open Source) &middot; Derived from <a href="${escapeHtml(upstreamUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(v.upstream?.name || 'obra/superpowers')} v${escapeHtml(v.upstream?.version || '7.0.2')}</a>`;
  }
  const svcVer = $('#svc-version-details');
  if (svcVer) {
    svcVer.innerHTML = `<strong>${escapeHtml(v.productName)} — ${escapeHtml(v.edition)} v${escapeHtml(v.version)}</strong> (${escapeHtml(v.license || 'MIT')} Open Source)<br>Repository: <a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repoUrl)}</a><br>Derived from <a href="${escapeHtml(upstreamUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(upstreamUrl)}</a> v${escapeHtml(v.upstream?.version || '7.0.2')} (${escapeHtml(v.upstream?.author || 'Jesse Vincent')}, ${escapeHtml(v.upstream?.license || 'MIT')})`;
  }
}

async function refreshSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions || [];
  renderSessionList();
}

function renderSessionList() {
  const list = $('#session-list');
  if (!state.sessions.length) {
    list.innerHTML = '<div class="muted small pad">No sessions yet. Click "+ New Session".</div>';
    return;
  }
  list.innerHTML = state.sessions.map((s) => {
    const active = s.id === state.activeSessionId ? 'active' : '';
    const ms = s.missionSummary || {};
    const pct = ms.totalCount > 0 ? Math.round((ms.doneCount / ms.totalCount) * 100) : 0;
    const taskTxt = ms.totalCount > 0 ? `<span>${ms.doneCount}/${ms.totalCount} tasks</span>` : '';
    const etaTxt = s.phase === 'running' && ms.etaSeconds != null ? `<span>ETA ~${formatDuration(ms.etaSeconds)}</span>` : '';
    const expTxt = s.activeExperts > 0 ? `<span>${s.activeExperts} active</span>` : (s.totalExperts ? `<span>${s.totalExperts} exp</span>` : '');
    return `
      <div class="session-item ${active}" data-sid="${escapeHtml(s.id)}">
        <div class="session-item-top">
          <div class="session-item-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
          <button class="btn-icon btn-del-session" data-del="${escapeHtml(s.id)}" title="Delete session">&times;</button>
        </div>
        <div class="session-item-sub">
          <span class="badge ${escapeHtml(s.phase)}">${escapeHtml(s.phase)}</span>
          ${taskTxt} ${expTxt} ${etaTxt}
        </div>
        ${ms.totalCount > 0 ? `<div class="sidebar-mini-bar"><div class="sidebar-mini-fill" style="width:${pct}%"></div></div>` : ''}
      </div>`;
  }).join('');

  list.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-del-session')) return;
      selectSession(el.dataset.sid);
    });
  });
  list.querySelectorAll('.btn-del-session').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSession(btn.dataset.del);
    });
  });
}

async function deleteSession(id) {
  await openDeleteSessionModal(id);
}

async function openDeleteSessionModal(id) {
  if (!id) return;
  try {
    const detail = await api(`/api/sessions/${encodeURIComponent(id)}`);
    const session = detail.session;
    const purgeInfo = detail.purgeInfo || {
      canDeleteWorkspace: false,
      targetDir: session.workspacePath || '',
      hasWorktree: Boolean(session.worktreeBranch),
      worktreeDir: session.effectiveWorkDir || null,
      worktreeBranch: session.worktreeBranch || null,
      reason: 'Workspace status unavailable.',
    };
    state.pendingDeleteSession = { id, session, purgeInfo };

    $('#del-session-heading').textContent = `Delete / Purge "${session.title}"`;
    $('#del-session-summary').textContent = 'Choose how much of this session to permanently erase:';

    const wtBox = $('#del-worktree-box');
    const chkBranch = $('#chk-purge-branch');
    if (purgeInfo.hasWorktree) {
      wtBox.classList.remove('hidden');
      $('#del-worktree-path').textContent = purgeInfo.worktreeDir || session.effectiveWorkDir || '';
      $('#del-worktree-branch').textContent = purgeInfo.worktreeBranch || session.worktreeBranch || '';
      chkBranch.checked = true;
    } else {
      wtBox.classList.add('hidden');
      chkBranch.checked = false;
    }

    $('#del-workspace-path').textContent = purgeInfo.targetDir || session.workspacePath || '(none)';
    const chkWs = $('#chk-purge-workspace');
    chkWs.checked = false;
    const checkWrap = $('#del-workspace-check-wrap');
    const protNote = $('#del-workspace-protected-note');
    if (purgeInfo.canDeleteWorkspace) {
      checkWrap.classList.remove('hidden');
      protNote.classList.add('hidden');
    } else {
      checkWrap.classList.add('hidden');
      protNote.textContent = `Protected: ${purgeInfo.reason || 'Cannot delete this folder.'}`;
      protNote.classList.remove('hidden');
    }

    syncDeleteButtonLabel();
    $('#modal-delete-session').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function syncDeleteButtonLabel() {
  const btn = $('#btn-confirm-delete-session');
  if (!btn) return;
  const purgeFiles = Boolean($('#chk-purge-workspace')?.checked || $('#chk-purge-branch')?.checked);
  btn.textContent = purgeFiles ? 'Purge Session & Files Permanently' : 'Delete Session';
}

async function confirmDeleteSession() {
  const pending = state.pendingDeleteSession;
  if (!pending) return;
  const { id, purgeInfo } = pending;
  const deleteBranch = Boolean(purgeInfo.hasWorktree && $('#chk-purge-branch')?.checked);
  const deleteWorkspace = Boolean(purgeInfo.canDeleteWorkspace && $('#chk-purge-workspace')?.checked);
  const params = new URLSearchParams();
  if (deleteBranch) {
    params.set('force', 'true');
    params.set('deleteBranch', 'true');
  }
  if (deleteWorkspace) {
    params.set('force', 'true');
    params.set('deleteWorkspace', 'true');
  }
  const qs = params.toString() ? `?${params.toString()}` : '';
  const btn = $('#btn-confirm-delete-session');
  btn.disabled = true;
  try {
    let res;
    try {
      res = await api(`/api/sessions/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
    } catch (err) {
      if (err.status === 409) {
        const files = (err.data?.dirtyFiles || []).join('\n');
        const ok = await showConfirmDialog(
          'Uncommitted Worktree Changes',
          `Session worktree has uncommitted changes:\n${files}\n\nForce-remove worktree anyway?`
        );
        if (!ok) return;
        params.set('force', 'true');
        res = await api(`/api/sessions/${encodeURIComponent(id)}?${params.toString()}`, { method: 'DELETE' });
      } else {
        throw err;
      }
    }

    $('#modal-delete-session').classList.add('hidden');
    $('#modal-session-settings').classList.add('hidden');
    state.pendingDeleteSession = null;

    if (state.activeSessionId === id) {
      state.activeSessionId = null;
      state.activeDetail = null;
    }
    const parts = ['Session deleted'];
    if (res?.worktreeRemoved) parts.push('worktree removed');
    if (res?.branchDeleted) parts.push('git branch deleted');
    if (res?.workspaceDeleted) parts.push('workspace directory erased');
    showToast(`${parts.join(' · ')}.`, 'info', 4500);
    await refreshSessions();
    renderMain();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function selectSession(id) {
  state.activeSessionId = id;
  state.selectedScreen = null;
  state.workspaceImages = [];
  state.streamingText = '';
  state.streamingReasoning = '';
  state.coordLiveText = '';
  state.pendingAttachments = [];
  renderPendingAttachments();
  showSessionError('');
  $('#companion-choice-bar').classList.add('hidden');
  renderSessionList();
  setMobilePane('chat');
  await loadSessionDetail(id);
  reloadCompanionFrame();
  refreshWorkspaceImages();
  refreshWorkspaceStatus();
}

async function loadSessionDetail(id, { timeline = true } = {}) {
  try {
    const prevCount = state.activeDetail?.messages?.length || 0;
    const detail = await api(`/api/sessions/${id}`);
    if (state.activeSessionId !== id) return;
    state.activeDetail = detail;
    const shouldRenderTimeline = timeline || (detail.messages?.length || 0) !== prevCount;
    renderMain({ renderTimeline: shouldRenderTimeline });
    renderAgentsAndMissionTab();
    renderScreenSelect();
    renderSkillsTab();
  } catch { /* ignore if deleted */ }
}

function renderMain({ renderTimeline = true } = {}) {
  if (!state.activeDetail) {
    $('#empty-state').classList.remove('hidden');
    $('#session-view').classList.add('hidden');
    return;
  }
  $('#empty-state').classList.add('hidden');
  $('#session-view').classList.remove('hidden');

  const { session, messages, coordinator, experts } = state.activeDetail;
  $('#session-title').textContent = session.title;
  const badge = $('#session-phase-badge');
  badge.textContent = session.phase;
  badge.className = `badge ${session.phase}`;

  const wsLabel = session.worktreeBranch
    ? `Worktree: ${session.worktreeBranch}`
    : session.effectiveWorkDir || session.workspacePath;
  const wsPill = $('#session-workspace-pill');
  wsPill.textContent = wsLabel;
  wsPill.title = session.effectiveWorkDir || session.workspacePath;

  const subM = `${session.providerId}/${session.model || 'default'}`;
  const coordM = session.coordinatorModel || session.coordinatorProviderId
    ? `${session.coordinatorProviderId || session.providerId}/${session.coordinatorModel || 'default'}`
    : subM;
  const modPill = $('#session-models-pill');
  modPill.textContent = `Sub: ${subM} · Coord: ${coordM}`;
  modPill.title = modPill.textContent;

  showSessionError(session.lastError || '');

  // Buttons visibility by phase
  const isInterview = session.phase === 'interview' || session.phase === 'ready';
  const isRunning = session.phase === 'running';
  const isPaused = session.phase === 'paused';
  const isResumable = isPaused || session.phase === 'failed' || session.phase === 'stopped';
  $('#btn-approve').classList.toggle('hidden', !isInterview);
  $('#btn-pause').classList.toggle('hidden', !isRunning);
  $('#btn-resume').classList.toggle('hidden', !isResumable);
  $('#btn-resume').textContent = session.phase === 'failed' ? 'Retry / Resume' : 'Resume';
  $('#btn-stop').classList.toggle('hidden', !(isRunning || isPaused));
  $('#btn-reopen').classList.toggle('hidden', isInterview);

  // Rules & plan fields
  const rulesTa = $('#rules-textarea');
  const planTa = $('#plan-textarea');
  if (document.activeElement !== rulesTa) rulesTa.value = session.rules || '';
  if (document.activeElement !== planTa) planTa.value = session.plan || '';
  rulesTa.readOnly = !isInterview;
  planTa.readOnly = !isInterview;
  $('#btn-save-rules').classList.toggle('hidden', !isInterview);
  $('#btn-drawer-approve').classList.toggle('hidden', !isInterview);
  if (session.phase === 'ready' && (session.rules || session.plan)) {
    $('#rules-drawer').classList.remove('hidden');
  }

  // Mission Strip: Status + Tasks + Elapsed + Potential ETA
  const cStatus = coordinator?.status || 'idle';
  const dot = $('#coord-live-dot');
  dot.className = `status-dot ${cStatus}`;
  const toolNote = coordinator?.currentTool ? ` · tool: ${coordinator.currentTool}` : '';
  $('#coord-status-text').textContent = cStatus === 'idle'
    ? 'Idle — awaiting approved rules'
    : `${cStatus.toUpperCase()} · Turn ${coordinator?.turnCount || 0}${toolNote}`;

  const ms = session.missionSummary || { doneCount: 0, totalCount: 0, etaSeconds: null, etaBasis: 'estimating', elapsedSeconds: 0 };
  const pct = ms.totalCount > 0 ? Math.round((ms.doneCount / ms.totalCount) * 100) : (session.phase === 'completed' ? 100 : 0);
  $('#mission-counts').textContent = ms.totalCount > 0 ? `${ms.doneCount} / ${ms.totalCount} tasks` : 'No tasks parsed';
  $('#mission-elapsed').textContent = `Elapsed: ${formatDuration(ms.elapsedSeconds || 0)}`;
  const etaEl = $('#mission-eta');
  if (session.phase === 'completed') {
    etaEl.textContent = 'ETA: Done';
    etaEl.title = 'Mission completed';
  } else if (ms.etaSeconds != null) {
    etaEl.textContent = `Potential ETA: ~${formatDuration(ms.etaSeconds)}`;
    etaEl.title = ms.etaBasis === 'rolling-average'
      ? 'Estimated from average duration of completed tasks × remaining tasks'
      : 'Estimated from Coordinator per-task time estimates';
  } else if (isRunning) {
    etaEl.textContent = 'ETA: Estimating…';
    etaEl.title = 'ETA updates automatically once Task 1 completes or Coordinator supplies estimates';
  } else {
    etaEl.textContent = 'ETA: —';
  }
  $('#mission-progress-bar').style.width = `${pct}%`;

  const autoBtn = $('#btn-toggle-uninterrupted');
  if (autoBtn) {
    const autoOn = session.uninterruptedMode !== false;
    autoBtn.textContent = autoOn ? 'Auto-Continue: ON' : 'Auto-Continue: OFF';
    autoBtn.className = `btn btn-xs ${autoOn ? 'btn-success' : 'btn-ghost'}`;
    autoBtn.title = autoOn
      ? 'Uninterrupted supervisor active — Coordinator runs without turn-limit pauses until 100% of tasks are done (click to switch to capped mode)'
      : 'Capped mode — Coordinator pauses at maxTurns or on stalls (click to enable uninterrupted mode)';
  }

  const runningExp = (experts || []).filter((e) => e.status === 'running').length;
  $('#agents-count-badge').textContent = runningExp > 0 ? `${runningExp} active` : `${(experts || []).length}`;

  renderActionBars(session);

  if (!renderTimeline) return;
  const tl = $('#timeline');
  tl.innerHTML = (messages || []).map((m) => {
    if (m.role === 'system') {
      return `<div class="msg system">${escapeHtml(m.content)}</div>`;
    }
    if (m.role === 'user') {
      const label = m.internalNotice ? 'Coordinator → Subordinate' : 'You';
      const attHtml = (m.attachments || []).length
        ? `<div class="msg-attachments">${m.attachments.map((a) =>
            `<img class="msg-att-thumb" src="/api/sessions/${encodeURIComponent(session.id)}/attachments/${encodeURIComponent(a.id)}" alt="${escapeHtml(a.filename)}" title="${escapeHtml(a.filename)}" data-full-img="/api/sessions/${encodeURIComponent(session.id)}/attachments/${encodeURIComponent(a.id)}">`
          ).join('')}</div>`
        : '';
      return `<div class="msg user"><div class="msg-header"><span class="tier-tag">${escapeHtml(label)}</span></div><div class="msg-body">${renderMarkdown(m.displayText || m.content)}</div>${attHtml}</div>`;
    }
    if (m.role === 'tool') {
      return `<div class="msg tool"><details class="fold"><summary>Tool result: ${escapeHtml(m.toolName || 'tool')}</summary><pre>${escapeHtml(m.content)}</pre></details></div>`;
    }
    const reasoningHtml = m.reasoning
      ? `<details class="fold"><summary>Reasoning</summary><pre>${escapeHtml(m.reasoning)}</pre></details>`
      : '';
    const callsHtml = (m.toolCalls || []).map((tc) =>
      `<details class="fold"><summary>Tool call: ${escapeHtml(tc.name)}</summary><pre>${escapeHtml(JSON.stringify(tc.arguments, null, 2))}</pre></details>`
    ).join('');
    return `
      <div class="msg assistant">
        <div class="msg-header"><span class="tier-tag">Subordinate</span></div>
        ${reasoningHtml}
        <div class="msg-body">${renderMarkdown(m.content || '')}</div>
        ${callsHtml}
      </div>`;
  }).join('');

  tl.querySelectorAll('[data-full-img]').forEach((img) => {
    img.addEventListener('click', () => {
      $('#viewer-title').textContent = img.alt || 'Image Attachment';
      $('#viewer-body').innerHTML = `<img class="lightbox-img" src="${escapeHtml(img.dataset.fullImg)}" alt="${escapeHtml(img.alt)}">`;
      $('#modal-viewer').classList.remove('hidden');
    });
  });

  tl.scrollTop = tl.scrollHeight;
}

async function executeQuickAction(action) {
  if (!state.activeSessionId || !action) return;
  try {
    if (action.kind === 'approve') {
      await approveActiveSession();
    } else if (action.kind === 'pause') {
      await api(`/api/sessions/${state.activeSessionId}/pause`, { method: 'POST' });
      showToast('Coordinator pausing…', 'warn');
      await loadSessionDetail(state.activeSessionId);
    } else if (action.kind === 'resume') {
      await api(`/api/sessions/${state.activeSessionId}/resume`, { method: 'POST' });
      showToast('Coordinator resumed.', 'success');
      await loadSessionDetail(state.activeSessionId);
    } else if (action.kind === 'reopen') {
      await api(`/api/sessions/${state.activeSessionId}/reopen-interview`, { method: 'POST' });
      showToast('Interview phase re-opened.', 'info');
      await loadSessionDetail(state.activeSessionId);
    } else if (action.kind === 'relay') {
      const composerText = ($('#composer-input')?.value || '').trim();
      let instructions = action.value || composerText;
      if (!instructions) {
        const msgs = state.activeDetail?.messages || [];
        const latest = [...msgs].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
        instructions = latest ? String(latest.displayText || latest.content || '').slice(0, 1200) : '';
      }
      if (!instructions) {
        showToast('Type instructions in the composer first to relay to Coordinator.', 'warn');
        $('#composer-input').focus();
        return;
      }
      if (composerText && !action.value) $('#composer-input').value = '';
      await api(`/api/sessions/${state.activeSessionId}/relay`, {
        method: 'POST',
        body: JSON.stringify({ instructions, priority: 'normal' }),
      });
      showToast('Relayed directly to Coordinator!', 'success');
      await loadSessionDetail(state.activeSessionId);
    } else if (action.kind === 'reply') {
      $('#composer-input').value = action.value || action.label;
      await sendComposerMessage();
    }
  } catch (err) {
    showSessionError(err.message);
    showToast(err.message, 'error');
  }
}

function renderActionBars(session) {
  const sugBar = $('#suggested-actions-bar');
  const suggested = Array.isArray(session.suggestedActions) ? session.suggestedActions : [];
  if (suggested.length > 0) {
    sugBar.classList.remove('hidden');
    sugBar.innerHTML = '<span class="quick-actions-label">Suggested:</span>' + suggested.map((a, i) => {
      const cls = a.style === 'success' ? 'btn-success' : a.style === 'primary' ? 'btn-primary' : a.style === 'warn' ? 'btn-warn' : 'btn-secondary';
      return `<button type="button" class="btn btn-xs ${cls}" data-sug-idx="${i}">${escapeHtml(a.label)}</button>`;
    }).join('');
    sugBar.querySelectorAll('[data-sug-idx]').forEach((btn) => {
      btn.addEventListener('click', () => executeQuickAction(suggested[Number(btn.dataset.sugIdx)]));
    });
  } else {
    sugBar.classList.add('hidden');
    sugBar.innerHTML = '';
  }

  const quickBar = $('#quick-actions-bar');
  let presets = [];
  if (session.phase === 'interview' || session.phase === 'ready') {
    presets = [
      { label: 'Proceed', kind: 'reply', value: 'Proceed', style: 'primary' },
      { label: 'Draft Rules & Plan', kind: 'reply', value: 'Finalize the rules and implementation plan and call propose_rules so I can dispatch.', style: 'secondary' },
      { label: 'Approve & Dispatch', kind: 'approve', style: 'success' },
    ];
  } else if (session.phase === 'running') {
    presets = [
      { label: 'Relay to Coordinator', kind: 'relay', value: '', style: 'primary' },
      { label: 'Status Update', kind: 'reply', value: 'Give me a concise status update from the Coordinator and active Experts.', style: 'secondary' },
      { label: 'Pause Coordinator', kind: 'pause', style: 'warn' },
    ];
  } else if (session.phase === 'paused' || session.phase === 'failed' || session.phase === 'stopped') {
    presets = [
      { label: session.phase === 'failed' ? 'Retry / Resume Coordinator' : 'Resume Coordinator', kind: 'resume', style: 'success' },
      { label: 'Relay & Resume', kind: 'relay', value: '', style: 'primary' },
      { label: 'Re-open Interview', kind: 'reopen', style: 'secondary' },
    ];
  } else {
    presets = [
      { label: 'Re-open Interview', kind: 'reopen', style: 'secondary' },
      { label: 'Relay Follow-up to Coordinator', kind: 'relay', value: '', style: 'primary' },
    ];
  }

  quickBar.innerHTML = '<span class="quick-actions-label">Quick Actions:</span>' + presets.map((a, i) => {
    const cls = a.style === 'success' ? 'btn-success' : a.style === 'primary' ? 'btn-primary' : a.style === 'warn' ? 'btn-warn' : 'btn-secondary';
    return `<button type="button" class="btn btn-xs ${cls}" data-qa-idx="${i}">${escapeHtml(a.label)}</button>`;
  }).join('');
  quickBar.querySelectorAll('[data-qa-idx]').forEach((btn) => {
    btn.addEventListener('click', () => executeQuickAction(presets[Number(btn.dataset.qaIdx)]));
  });
}

function renderAgentsAndMissionTab() {
  const el = $('#coord-inspector');
  if (!state.activeDetail) {
    el.innerHTML = '<p class="muted pad">Select a session to view live Agents, tasks, and ETA.</p>';
    return;
  }
  const { session, coordinator, experts } = state.activeDetail;
  const cStatus = coordinator?.status || 'idle';
  const subStatus = state.subordinateBusy ? 'running' : 'completed';
  const subModel = `${session.providerId}/${session.model || 'default'}`;
  const coordModel = `${session.coordinatorProviderId || session.providerId}/${session.coordinatorModel || session.model || 'default'}`;
  const allExperts = [...(experts || [])].reverse(); // newest first
  const runningExperts = allExperts.filter((e) => e.status === 'running');
  const finishedExperts = allExperts.filter((e) => e.status !== 'running');

  const renderActiveExpertCard = (ex) => {
    const liveTxt = state.expertLiveText[ex.id] || '';
    const durSec = ex.startedAt
      ? Math.max(0, Math.round(((ex.completedAt ? Date.parse(ex.completedAt) : Date.now()) - Date.parse(ex.startedAt)) / 1000))
      : null;
    return `
      <div class="agent-node ${escapeHtml(ex.status)}">
        <div class="agent-node-top">
          <div class="agent-node-title">
            <span class="status-dot ${escapeHtml(ex.status)}"></span>
            <span>${escapeHtml(ex.role)}</span>
          </div>
          <span class="badge ${escapeHtml(ex.status)}">${escapeHtml(ex.status)}</span>
        </div>
        <div class="agent-node-meta">
          <span>${escapeHtml(ex.model || '')}</span>
          ${ex.taskId ? `<span>&middot; ${escapeHtml(ex.taskId)}</span>` : ''}
          ${durSec != null ? `<span>&middot; ${formatDuration(durSec)}</span>` : ''}
          ${ex.readOnly ? '<span>&middot; read-only</span>' : ''}
        </div>
        ${ex.currentTool ? `<div class="tool-activity-pill">Running: ${escapeHtml(ex.currentTool)}</div>` : ''}
        <div class="small" style="margin-top:5px">${escapeHtml(String(ex.task || '').slice(0, 120))}</div>
        <div class="agent-live-snippet ${liveTxt ? '' : 'hidden'}" data-expert-live="${escapeHtml(ex.id)}">${escapeHtml(liveTxt)}</div>
        <div class="card-box-actions">
          <button class="btn btn-xs btn-secondary btn-view-expert" data-expid="${escapeHtml(ex.id)}">Inspect Transcript</button>
        </div>
      </div>`;
  };

  const renderCompactExpertRow = (ex) => {
    const durSec = ex.startedAt
      ? Math.max(0, Math.round(((ex.completedAt ? Date.parse(ex.completedAt) : Date.now()) - Date.parse(ex.startedAt)) / 1000))
      : null;
    return `
      <div class="expert-compact-row ${escapeHtml(ex.status)}">
        <div class="expert-compact-main">
          <div class="expert-compact-top">
            <span class="status-dot ${escapeHtml(ex.status)}"></span>
            <strong class="expert-compact-role">${escapeHtml(ex.role)}</strong>
            ${durSec != null ? `<span class="muted small">${formatDuration(durSec)}</span>` : ''}
            ${ex.status !== 'completed' ? `<span class="badge ${escapeHtml(ex.status)}">${escapeHtml(ex.status)}</span>` : ''}
          </div>
          <div class="expert-compact-task" title="${escapeHtml(ex.task || '')}">${escapeHtml(String(ex.task || '').slice(0, 90))}</div>
        </div>
        <button class="btn btn-xs btn-ghost btn-view-expert" data-expid="${escapeHtml(ex.id)}">Transcript</button>
      </div>`;
  };

  // 1. Live 3-Tier Visual Agent Graph (Active Experts pinned open; Completed Experts collapsed in drawer)
  const failedCount = finishedExperts.filter((e) => e.status === 'failed').length;
  const finishedSummaryNote = failedCount > 0 ? `${finishedExperts.length - failedCount} done · ${failedCount} failed` : `${finishedExperts.length} done`;
  const activeExpertsHtml = runningExperts.length
    ? `<div class="experts-grid">${runningExperts.map(renderActiveExpertCard).join('')}</div>`
    : (finishedExperts.length === 0
        ? `<div class="card-box small muted">No Experts dispatched yet. Once approved, Coordinator spawns specialists (Senior DICOM Engineer, HL7/FHIR Engineer, Anatomical Illustrator, Human Physiology Expert, Implementer, Reviewer…) here in real time.</div>`
        : '');
  const completedExpertsDrawerHtml = finishedExperts.length
    ? `<details class="drawer-box" data-ui-toggle="showCompletedExperts" ${state.ui.showCompletedExperts ? 'open' : ''}>
         <summary class="drawer-summary">
           <span>Completed Experts (${finishedExperts.length})</span>
           <span class="badge ${failedCount > 0 ? 'failed' : 'completed'}">${escapeHtml(finishedSummaryNote)}</span>
         </summary>
         <div class="expert-compact-list">${finishedExperts.map(renderCompactExpertRow).join('')}</div>
       </details>`
    : '';
  const expertsCardsHtml = `${activeExpertsHtml}${completedExpertsDrawerHtml}`;

  // 2. Mission Board (Working On / Up Next pinned open; Done collapsed in expandable drawer)
  const tasks = session.tasks || [];
  const workingTasks = tasks.filter((t) => t.status === 'in_progress' || t.status === 'blocked');
  const nextTasks = tasks.filter((t) => t.status === 'pending');
  const doneTasks = tasks.filter((t) => t.status === 'done' || t.status === 'failed');

  const renderTaskRow = (t) => {
    const dur = t.durationMs
      ? formatDuration(t.durationMs / 1000)
      : (t.startedAt && t.status === 'in_progress'
          ? `${formatDuration((Date.now() - Date.parse(t.startedAt)) / 1000)} elapsed`
          : (t.estimateSec ? `est ~${formatDuration(t.estimateSec)}` : ''));
    return `
      <div class="task-row ${escapeHtml(t.status)}">
        <div class="task-row-top">
          <span>${t.status === 'done' ? '✓ ' : t.status === 'in_progress' ? '● ' : '○ '}${escapeHtml(t.title)}</span>
          <span class="badge ${escapeHtml(t.status)}">${escapeHtml(t.status.replace('_', ' '))}</span>
        </div>
        <div class="task-row-sub">
          ${t.assignedAgent ? `<span>Agent: <strong>${escapeHtml(t.assignedAgent)}</strong></span>` : ''}
          ${dur ? `<span>${escapeHtml(dur)}</span>` : ''}
          ${t.note ? `<span>${escapeHtml(t.note)}</span>` : ''}
        </div>
      </div>`;
  };

  const missionBoardHtml = `
    <div class="mission-board">
      <div class="board-group">
        <div class="board-group-header"><span>Working On</span><span>${workingTasks.length}</span></div>
        ${workingTasks.length ? workingTasks.map(renderTaskRow).join('') : '<div class="small muted">Nothing actively executing yet.</div>'}
      </div>
      <div class="board-group">
        <div class="board-group-header"><span>Up Next</span><span>${nextTasks.length}</span></div>
        ${nextTasks.length ? nextTasks.map(renderTaskRow).join('') : '<div class="small muted">No upcoming tasks queued.</div>'}
      </div>
      <details class="drawer-box board-drawer" data-ui-toggle="showDoneTasks" ${state.ui.showDoneTasks ? 'open' : ''}>
        <summary class="drawer-summary">
          <span>Done Tasks (${doneTasks.length})</span>
          <span class="badge completed">${doneTasks.length} / ${tasks.length}</span>
        </summary>
        ${doneTasks.length ? doneTasks.map(renderTaskRow).join('') : '<div class="small muted" style="margin-top:6px">No tasks completed yet.</div>'}
      </details>
    </div>`;

  const dirs = (coordinator?.directives || []).map((d) => `<li>${escapeHtml(d.instructions)}</li>`).join('');
  const coordMsgs = (coordinator?.messages || []).slice(-10).map((m) => {
    if (m.role === 'tool') {
      return `<details class="fold"><summary>Result: ${escapeHtml(m.toolName)}</summary><pre>${escapeHtml(String(m.content || '').slice(0, 1500))}</pre></details>`;
    }
    const calls = (m.toolCalls || []).map((tc) => `<code>${escapeHtml(tc.name)}</code>`).join(' ');
    return `<div class="small" style="margin-top:6px"><strong>${escapeHtml(m.role)}:</strong> ${escapeHtml(String(m.content || '').slice(0, 400))} ${calls}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="agent-topology">
      <div class="agent-node ${subStatus === 'running' ? 'running' : ''}">
        <div class="agent-node-top">
          <div class="agent-node-title">
            <span class="status-dot ${subStatus}"></span>
            <span>Subordinate Agent</span>
          </div>
          <span class="badge ${escapeHtml(session.phase)}">${state.subordinateBusy ? 'streaming' : escapeHtml(session.phase)}</span>
        </div>
        <div class="agent-node-meta"><span>${escapeHtml(subModel)}</span><span>&middot; Human interface &amp; mission relay</span></div>
      </div>

      <div class="agent-connector ${cStatus === 'running' ? 'active' : ''}">
        <div class="arrow-line"></div>
        <span>${cStatus === 'running' ? 'Relaying directives &amp; status' : 'Handoff on Approve &amp; Dispatch'}</span>
      </div>

      <div class="agent-node ${escapeHtml(cStatus)}">
        <div class="agent-node-top">
          <div class="agent-node-title">
            <span class="status-dot ${escapeHtml(cStatus)}"></span>
            <span>Coordinator Agent</span>
          </div>
          <span class="badge ${escapeHtml(cStatus)}">${escapeHtml(cStatus)}</span>
        </div>
        <div class="agent-node-meta">
          <span>${escapeHtml(coordModel)}</span>
          <span>&middot; Turns: ${coordinator?.turnCount || 0}</span>
        </div>
        ${coordinator?.currentTool ? `<div class="tool-activity-pill">Running: ${escapeHtml(coordinator.currentTool)}</div>` : ''}
        <div id="coord-live-stream" class="agent-live-snippet ${state.coordLiveText ? '' : 'hidden'}">${escapeHtml(state.coordLiveText)}</div>
        ${dirs ? `<details class="fold" data-ui-toggle="showDirectives" ${state.ui.showDirectives ? 'open' : ''}><summary>Relayed Directives (${coordinator.directives.length})</summary><ul class="small" style="padding-left:18px;margin:6px 0">${dirs}</ul></details>` : ''}
        <details class="fold" data-ui-toggle="showCoordTrace" ${state.ui.showCoordTrace ? 'open' : ''}><summary>Coordinator Trace (${(coordinator?.messages || []).length} events)</summary>${coordMsgs || '<div class="muted small">No events yet.</div>'}</details>
      </div>

      <div class="agent-connector ${runningExperts.length > 0 ? 'active' : ''}">
        <div class="arrow-line"></div>
        <span>${runningExperts.length > 0 ? `${runningExperts.length} Expert(s) actively executing` : `Experts / Subagents (${allExperts.length})`}</span>
      </div>

      ${expertsCardsHtml}
    </div>

    <div class="sidebar-section-label" style="padding:8px 0 0">Mission Progress (${tasks.filter((t) => t.status === 'done').length}/${tasks.length})</div>
    ${missionBoardHtml}
  `;

  el.querySelectorAll('[data-ui-toggle]').forEach((det) => {
    det.addEventListener('toggle', () => {
      state.ui[det.dataset.uiToggle] = det.open;
    });
  });

  el.querySelectorAll('.btn-view-expert').forEach((btn) => {
    btn.addEventListener('click', () => openExpertTranscript(btn.dataset.expid));
  });
}

async function openExpertTranscript(expertId) {
  try {
    const { expert } = await api(`/api/sessions/${state.activeSessionId}/experts/${expertId}`);
    $('#viewer-title').textContent = `${expert.role} (${expert.status} · ${expert.model})`;
    const html = (expert.messages || []).map((m) => `
      <div class="card-box">
        <div class="small"><strong>${escapeHtml(m.role)}</strong> ${m.toolName ? `(${escapeHtml(m.toolName)})` : ''}</div>
        <pre>${escapeHtml(m.content || '')}</pre>
        ${(m.toolCalls || []).length ? `<pre>${escapeHtml(JSON.stringify(m.toolCalls, null, 2))}</pre>` : ''}
      </div>
    `).join('');
    $('#viewer-body').innerHTML = html || '<p class="muted">No transcript messages.</p>';
    $('#modal-viewer').classList.remove('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderScreenSelect() {
  const sel = $('#companion-screen-select');
  if (!sel) return;
  const screens = state.activeDetail?.screens || [];
  const activeName = state.selectedScreen || state.activeDetail?.latestScreen || screens[0]?.filename || '';
  if (!screens.length) {
    sel.innerHTML = '<option value="">No screens pushed yet</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = screens.map((s) =>
    `<option value="${escapeHtml(s.filename)}" ${s.filename === activeName ? 'selected' : ''}>${escapeHtml(s.filename)}</option>`
  ).join('');
}

function setVisualMode(mode) {
  state.visualMode = mode === 'files' ? 'files' : 'screens';
  const isFiles = state.visualMode === 'files';
  $('#companion-frame').classList.toggle('hidden', isFiles);
  $('#visual-files-pane').classList.toggle('hidden', !isFiles);
  $('#companion-screen-select').classList.toggle('hidden', isFiles);
  $('#btn-visual-mode-screens').className = `btn btn-xs ${!isFiles ? 'btn-primary' : 'btn-ghost'}`;
  $('#btn-visual-mode-files').className = `btn btn-xs ${isFiles ? 'btn-primary' : 'btn-ghost'}`;
  if (isFiles) {
    refreshWorkspaceImages();
  }
}

async function refreshWorkspaceImages() {
  if (!state.activeSessionId) return;
  try {
    const { images } = await api(`/api/sessions/${state.activeSessionId}/workspace/images`);
    state.workspaceImages = images || [];
    const cnt = $('#visual-files-count');
    if (cnt) cnt.textContent = state.workspaceImages.length ? `(${state.workspaceImages.length})` : '';
    renderWorkspaceImagesGrid();
  } catch { /* ignore */ }
}

function renderWorkspaceImagesGrid() {
  const grid = $('#visual-files-grid');
  if (!grid || !state.activeSessionId) return;
  const q = ($('#visual-files-filter')?.value || '').trim().toLowerCase();
  const list = state.workspaceImages.filter((img) => !q || img.path.toLowerCase().includes(q));
  if (!list.length) {
    grid.innerHTML = '<div class="muted small pad">No PNG/SVG/JPG outputs found in workspace yet.</div>';
    return;
  }
  grid.innerHTML = list.map((img) => {
    const src = `/api/sessions/${encodeURIComponent(state.activeSessionId)}/workspace/file?path=${encodeURIComponent(img.path)}&t=${Math.floor(img.mtimeMs || 0)}`;
    const kb = Math.max(1, Math.round((img.sizeBytes || 0) / 1024));
    return `
      <div class="visual-file-card" data-wimg-src="${escapeHtml(src)}" data-wimg-title="${escapeHtml(img.path)}">
        <img class="visual-file-thumb" loading="lazy" src="${escapeHtml(src)}" alt="${escapeHtml(img.filename)}">
        <div class="visual-file-meta">
          <div class="visual-file-name" title="${escapeHtml(img.filename)}">${escapeHtml(img.filename)}</div>
          <div class="visual-file-path" title="${escapeHtml(img.path)}">${escapeHtml(img.path)} · ${kb} KB</div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.visual-file-card').forEach((card) => {
    card.addEventListener('click', () => {
      $('#viewer-title').textContent = card.dataset.wimgTitle || 'Workspace Output';
      $('#viewer-body').innerHTML = `<img class="lightbox-img" src="${escapeHtml(card.dataset.wimgSrc)}" alt="${escapeHtml(card.dataset.wimgTitle)}">`;
      $('#modal-viewer').classList.remove('hidden');
    });
  });
}

function reloadCompanionFrame(explicitFilename) {
  if (!state.activeSessionId) return;
  const target = explicitFilename !== undefined ? explicitFilename : (state.selectedScreen || state.activeDetail?.latestScreen || '');
  state.selectedScreen = target || null;
  const frame = $('#companion-frame');
  const q = target ? `screen=${encodeURIComponent(target)}&t=${Date.now()}` : `t=${Date.now()}`;
  frame.src = `/api/sessions/${state.activeSessionId}/companion?${q}`;
  state.loadedCompanionSessionId = state.activeSessionId;
  renderScreenSelect();
}

function initPaneResizers() {
  const shell = $('#app');
  const leftHandle = $('#resizer-left');
  const rightHandle = $('#resizer-right');
  if (!shell || !leftHandle || !rightHandle) return;

  const setWidth = (varName, px, storageKey) => {
    shell.style?.setProperty?.(varName, `${px}px`);
    try { localStorage.setItem(storageKey, String(px)); } catch { /* ignore */ }
  };

  try {
    const savedL = Number(localStorage.getItem('sp_studio_left_w'));
    const savedR = Number(localStorage.getItem('sp_studio_right_w'));
    if (savedL >= 180 && savedL <= 460) shell.style?.setProperty?.('--left-w', `${savedL}px`);
    if (savedR >= 260 && savedR <= 1000) shell.style?.setProperty?.('--right-w', `${savedR}px`);
  } catch { /* ignore */ }

  const attachDrag = (handle, side) => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      shell.classList.add('resizing');
      if (side === 'right') {
        shell.classList.remove('expanded-right');
        const expBtn = $('#btn-expand-right');
        if (expBtn) expBtn.textContent = 'Expand';
      }

      const onMove = (ev) => {
        const vw = window.innerWidth || 1400;
        if (side === 'left') {
          const w = Math.max(180, Math.min(460, Math.round(ev.clientX)));
          setWidth('--left-w', w, 'sp_studio_left_w');
        } else {
          const w = Math.max(260, Math.min(Math.max(480, vw - 460), Math.round(vw - ev.clientX)));
          setWidth('--right-w', w, 'sp_studio_right_w');
        }
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        shell.classList.remove('resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      if (side === 'left') setWidth('--left-w', 250, 'sp_studio_left_w');
      else {
        shell.classList.remove('expanded-right');
        setWidth('--right-w', 420, 'sp_studio_right_w');
      }
    });
  };

  attachDrag(leftHandle, 'left');
  attachDrag(rightHandle, 'right');
}

// Sandboxed iframe postMessage bridge -> authenticated POST /companion/events
window.addEventListener('message', async (ev) => {
  const frame = $('#companion-frame');
  if (!frame || ev.source !== frame.contentWindow) return;
  if (!ev.data || ev.data.type !== 'superpowers-companion-event') return;
  const sid = ev.data.sessionId;
  if (!sid || sid !== state.activeSessionId) return;
  try {
    await api(`/api/sessions/${sid}/companion/events`, {
      method: 'POST',
      body: JSON.stringify(ev.data.event || {}),
    });
  } catch { /* ignore */ }
});

// ----- Image Copy-Paste, Drag-and-Drop, and Upload -----

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

async function handleImageFiles(files) {
  if (!state.activeSessionId) {
    showToast('Create or select a session before attaching images.', 'warn');
    return;
  }
  const list = [...(files || [])].filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!list.length) return;
  for (const file of list) {
    try {
      const dataUrl = await fileToDataUrl(file);
      const { attachment } = await api(`/api/sessions/${state.activeSessionId}/attachments`, {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name || `pasted-${Date.now()}.png`,
          mimeType: file.type,
          dataUrl,
        }),
      });
      state.pendingAttachments.push({
        ...attachment,
        previewUrl: `/api/sessions/${encodeURIComponent(state.activeSessionId)}/attachments/${encodeURIComponent(attachment.id)}`,
      });
      renderPendingAttachments();
      showToast(`Attached ${attachment.filename}`, 'success', 2500);
    } catch (err) {
      showToast(`Image upload failed: ${err.message}`, 'error');
    }
  }
}

function renderPendingAttachments() {
  const strip = $('#pending-attachments');
  if (!state.pendingAttachments.length) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  strip.classList.remove('hidden');
  strip.innerHTML = state.pendingAttachments.map((a, idx) => `
    <div class="att-chip">
      <img src="${escapeHtml(a.previewUrl)}" alt="${escapeHtml(a.filename)}">
      <span>${escapeHtml(a.filename)}</span>
      <button type="button" data-rm-att="${idx}" title="Remove">&times;</button>
    </div>
  `).join('');
  strip.querySelectorAll('[data-rm-att]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.pendingAttachments.splice(Number(btn.dataset.rmAtt), 1);
      renderPendingAttachments();
    });
  });
}

function renderSkillsTab() {
  const q = ($('#skill-search').value || '').toLowerCase();
  const pinned = new Set(state.activeDetail?.session?.pinnedSkills || []);
  const filtered = state.skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  );
  const el = $('#skills-list');
  el.innerHTML = filtered.map((s) => {
    const isPinned = pinned.has(s.name);
    return `
      <div class="card-box">
        <div class="card-box-header">
          <span class="card-box-title">${escapeHtml(s.name)}</span>
          ${isPinned ? '<span class="badge running">pinned</span>' : ''}
        </div>
        <div class="small muted">${escapeHtml(s.description)}</div>
        <div class="card-box-actions">
          <button class="btn btn-xs btn-secondary btn-view-skill" data-skill="${escapeHtml(s.name)}">Read SKILL.md</button>
          <button class="btn btn-xs ${isPinned ? 'btn-warn' : 'btn-ghost'} btn-pin-skill" data-skill="${escapeHtml(s.name)}">${isPinned ? 'Unpin' : 'Pin to Session'}</button>
          <button class="btn btn-xs btn-primary btn-use-skill" data-skill="${escapeHtml(s.name)}">Use in Chat</button>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.btn-view-skill').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        const data = await api(`/api/skills/${encodeURIComponent(b.dataset.skill)}`);
        $('#viewer-title').textContent = `Skill: ${data.name}`;
        $('#viewer-body').innerHTML = `<pre>${escapeHtml(data.content)}</pre>`;
        $('#modal-viewer').classList.remove('hidden');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  el.querySelectorAll('.btn-pin-skill').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!state.activeSessionId) return showToast('Create or select a session first.', 'warn');
      try {
        const next = new Set(state.activeDetail?.session?.pinnedSkills || []);
        if (next.has(b.dataset.skill)) next.delete(b.dataset.skill);
        else next.add(b.dataset.skill);
        await api(`/api/sessions/${state.activeSessionId}/skills`, {
          method: 'PUT',
          body: JSON.stringify({ pinnedSkills: [...next] }),
        });
        await loadSessionDetail(state.activeSessionId);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  el.querySelectorAll('.btn-use-skill').forEach((b) => {
    b.addEventListener('click', () => {
      const input = $('#composer-input');
      input.value = `/${b.dataset.skill} ${input.value}`.trimStart();
      input.focus();
    });
  });
}

async function refreshWorkspaceStatus() {
  const el = $('#workspace-status');
  if (!state.activeSessionId) {
    el.innerHTML = '<p class="muted pad">Select a session.</p>';
    return;
  }
  try {
    const st = await api(`/api/sessions/${state.activeSessionId}/workspace/status`);
    const filesHtml = (st.changedFiles || []).length
      ? st.changedFiles.map((f) => `<div class="small"><code>${escapeHtml(f.status)}</code> ${escapeHtml(f.path)}</div>`).join('')
      : '<div class="muted small">Working tree clean.</div>';
    el.innerHTML = `
      <div class="card-box">
        <div class="small"><strong>Primary Workspace:</strong><br><code>${escapeHtml(st.workspacePath)}</code></div>
        <div class="small" style="margin-top:6px"><strong>Active Working Dir:</strong><br><code>${escapeHtml(st.effectiveWorkDir)}</code></div>
        <div class="small" style="margin-top:6px"><strong>Git Branch:</strong> ${escapeHtml(st.branch || (st.isGit ? 'HEAD' : 'Not a git repo'))}</div>
        ${st.worktreeBranch ? `<div class="small" style="margin-top:4px;color:var(--accent)">Isolated parallel worktree branch: <code>${escapeHtml(st.worktreeBranch)}</code></div>` : ''}
      </div>
      <div class="card-box">
        <div class="card-box-title" style="margin-bottom:6px">Changed Files (${(st.changedFiles || []).length})</div>
        ${filesHtml}
      </div>`;
  } catch (err) {
    el.innerHTML = `<p class="muted pad">${escapeHtml(err.message)}</p>`;
  }
}

// ----- Modals: New Session, Providers, Expert Roster -----

function populateProviderSelect(selectEl, includeInherit = false) {
  const opts = includeInherit ? '<option value="">(Inherit)</option>' : '';
  selectEl.innerHTML = opts + state.providers.map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} ${p.hasKey ? '✓' : '(no key)'}</option>`
  ).join('');
}

function bindProviderModelDatalist(selectEl, inputEl, datalistEl) {
  const sync = (isChange = false) => {
    const p = state.providers.find((x) => x.id === selectEl.value);
    datalistEl.innerHTML = (p?.models || []).map((m) => `<option value="${escapeHtml(m)}">`).join('');
    if (selectEl.id === 'ns-sub-provider' || selectEl.id === 'ss-sub-provider') {
      if (isChange || !inputEl.value) {
        inputEl.value = p?.defaultModel || '';
      }
    } else if (isChange) {
      inputEl.value = p?.defaultModel || '';
    }
  };
  selectEl.onchange = () => sync(true);
  sync(false);
}

function openSessionSettingsModal() {
  const session = state.activeDetail?.session;
  if (!session) return;
  populateProviderSelect($('#ss-sub-provider'), false);
  populateProviderSelect($('#ss-coord-provider'), true);
  populateProviderSelect($('#ss-exp-provider'), true);

  $('#ss-title').value = session.title || '';
  $('#ss-workspace').value = session.effectiveWorkDir || session.workspacePath || '';
  $('#ss-sub-provider').value = session.providerId || state.providers[0]?.id || '';
  $('#ss-sub-model').value = session.model || '';
  $('#ss-coord-provider').value = session.coordinatorProviderId || '';
  $('#ss-coord-model').value = session.coordinatorModel || '';
  $('#ss-exp-provider').value = session.expertProviderId || '';
  $('#ss-exp-model').value = session.expertModel || '';
  $('#ss-uninterrupted').checked = session.uninterruptedMode !== false;
  $('#ss-max-turns').value = session.maxTurns || 100;

  bindProviderModelDatalist($('#ss-sub-provider'), $('#ss-sub-model'), $('#dl-ss-sub-models'));
  bindProviderModelDatalist($('#ss-coord-provider'), $('#ss-coord-model'), $('#dl-ss-coord-models'));
  bindProviderModelDatalist($('#ss-exp-provider'), $('#ss-exp-model'), $('#dl-ss-exp-models'));
  $('#modal-session-settings').classList.remove('hidden');
}

function openNewSessionModal() {
  populateProviderSelect($('#ns-sub-provider'), false);
  populateProviderSelect($('#ns-coord-provider'), true);
  populateProviderSelect($('#ns-exp-provider'), true);
  $('#new-session-workspace').value = state.defaultWorkspace;
  $('#ns-sub-model').value = '';
  $('#ns-coord-model').value = '';
  $('#ns-exp-model').value = '';
  bindProviderModelDatalist($('#ns-sub-provider'), $('#ns-sub-model'), $('#dl-sub-models'));
  bindProviderModelDatalist($('#ns-coord-provider'), $('#ns-coord-model'), $('#dl-coord-models'));
  bindProviderModelDatalist($('#ns-exp-provider'), $('#ns-exp-model'), $('#dl-exp-models'));
  $('#modal-new-session').classList.remove('hidden');
}

function openProvidersModal() {
  renderProviderList();
  selectProviderInModal(state.selectedProviderId || state.providers[0]?.id);
  $('#modal-providers').classList.remove('hidden');
}

function renderProviderList() {
  const list = $('#provider-list');
  list.innerHTML = state.providers.map((p) => `
    <div class="modal-list-item ${p.id === state.selectedProviderId ? 'active' : ''}" data-pid="${escapeHtml(p.id)}">
      <div>${escapeHtml(p.name)}</div>
      <div class="small muted">${escapeHtml(p.kind)} · ${p.hasKey ? 'Key set' : 'No key'}</div>
    </div>
  `).join('');
  list.querySelectorAll('.modal-list-item').forEach((el) => {
    el.addEventListener('click', () => selectProviderInModal(el.dataset.pid));
  });
}

function selectProviderInModal(id) {
  state.selectedProviderId = id;
  renderProviderList();
  const p = state.providers.find((x) => x.id === id);
  const f = $('#form-provider');
  $('#provider-test-result').textContent = '';
  if (!p) {
    f.reset();
    f.elements.id.readOnly = false;
    $('#provider-key-status').textContent = 'New custom provider';
    return;
  }
  f.elements.id.value = p.id;
  f.elements.id.readOnly = true;
  f.elements.name.value = p.name;
  f.elements.kind.value = p.kind;
  f.elements.baseUrl.value = p.baseUrl || '';
  f.elements.apiKey.value = '';
  f.elements.envVar.value = p.envVar || '';
  f.elements.toolMode.value = p.toolMode || 'auto';
  f.elements.defaultModel.value = p.defaultModel || '';
  $('#dl-prov-models').innerHTML = (p.models || []).map((m) => `<option value="${escapeHtml(m)}">`).join('');
  $('#provider-key-status').textContent = p.hasKey
    ? `Active key source: ${p.keySource} (${p.keyPreview})`
    : 'No API key saved or found in environment variable.';
}

function openExpertsModal() {
  populateProviderSelect($('#exp-edit-provider'), true);
  renderExpertRosterList();
  selectExpertInModal(state.selectedExpertId || state.expertsRoster[0]?.id);
  $('#modal-experts').classList.remove('hidden');
}

async function openServiceModal() {
  $('#modal-service').classList.remove('hidden');
  await refreshServiceModal();
}

async function refreshServiceModal() {
  try {
    const info = await api('/api/service');
    state.serviceInfo = info;
    const modeBadge = $('#svc-mode-badge');
    modeBadge.textContent = info.detached ? 'detached daemon' : 'foreground / child';
    modeBadge.className = `badge ${info.detached ? 'completed' : 'ready'}`;
    $('#svc-status-details').textContent = `PID ${info.pid} · Uptime: ${formatDuration(info.uptimeSec || 0)} · Data: ${info.dataDir}`;
    $('#svc-url-input').value = info.url || '';
    $('#chk-auto-resume').checked = info.autoResumeOnRestart !== false;

    const win = info.windowsService || {};
    const winBadge = $('#svc-win-badge');
    const winBtn = $('#btn-toggle-win-service');
    if (!win.supported) {
      winBadge.textContent = 'windows only';
      winBadge.className = 'badge';
      winBtn.disabled = true;
      winBtn.textContent = 'Windows Only';
    } else if (win.installed) {
      winBadge.textContent = 'enabled';
      winBadge.className = 'badge completed';
      winBtn.disabled = false;
      winBtn.className = 'btn btn-sm btn-warn';
      winBtn.textContent = 'Disable Windows Auto-Start';
    } else {
      winBadge.textContent = 'disabled';
      winBadge.className = 'badge';
      winBtn.disabled = false;
      winBtn.className = 'btn btn-sm btn-primary';
      winBtn.textContent = 'Enable Windows Auto-Start';
    }

    const sc = info.windowsShortcuts || {};
    const iconBadge = $('#svc-icon-badge');
    const iconBtn = $('#btn-toggle-win-icons');
    if (iconBadge && iconBtn) {
      if (!sc.supported) {
        iconBadge.textContent = 'windows only';
        iconBadge.className = 'badge';
        iconBtn.disabled = true;
        iconBtn.textContent = 'Windows Only';
      } else if (sc.installed) {
        const where = [sc.desktop?.exists && 'Desktop', sc.startMenu?.exists && 'Start Menu'].filter(Boolean).join(' + ');
        iconBadge.textContent = where || 'created';
        iconBadge.className = 'badge completed';
        iconBtn.disabled = false;
        iconBtn.className = 'btn btn-sm btn-warn';
        iconBtn.textContent = 'Remove Windows Icon';
      } else {
        iconBadge.textContent = 'not created';
        iconBadge.className = 'badge';
        iconBtn.disabled = false;
        iconBtn.className = 'btn btn-sm btn-primary';
        iconBtn.textContent = 'Create Windows Icon';
      }
    }

    renderMobileAccessSection(info.mobile);
    if (info.versionInfo) renderVersionBadges(info.versionInfo);
  } catch (err) {
    $('#svc-status-details').textContent = `Unable to load service status (restart Studio server to activate /api/service): ${err.message}`;
  }
}

function renderMobileAccessSection(mobile) {
  if (!mobile) return;
  const badge = $('#svc-mobile-badge');
  const btn = $('#btn-toggle-mobile-access');
  const qrSection = $('#mobile-qr-section');
  const restartNote = $('#svc-mobile-restart-note');
  if (badge) {
    badge.textContent = mobile.enabled
      ? (mobile.listeningAllInterfaces ? 'live (LAN / Tailscale)' : 'enabled (restart needed)')
      : 'localhost only';
    badge.className = `badge ${mobile.enabled ? (mobile.listeningAllInterfaces ? 'completed' : 'ready') : ''}`;
  }
  if (btn) {
    btn.textContent = mobile.enabled ? 'Disable Mobile / Remote Access' : 'Enable Mobile / LAN & Tailscale Access';
    btn.className = `btn btn-sm ${mobile.enabled ? 'btn-warn' : 'btn-primary'}`;
  }
  if (restartNote) {
    restartNote.classList.toggle('hidden', !mobile.needsRestartToBind);
  }
  const endpoints = mobile.endpoints || [];
  if (qrSection) {
    qrSection.classList.toggle('hidden', !mobile.enabled || endpoints.length === 0);
  }
  const sel = $('#mobile-endpoint-select');
  if (sel && endpoints.length > 0) {
    sel.innerHTML = endpoints.map((ep, idx) =>
      `<option value="${idx}">${escapeHtml(ep.label)} — ${escapeHtml(ep.ip)}</option>`
    ).join('');
    const showEp = (idx) => {
      const ep = endpoints[idx] || endpoints[0];
      if (!ep) return;
      $('#mobile-qr-container').innerHTML = ep.qrSvg || '<span class="muted small">QR unavailable</span>';
      $('#mobile-url-input').value = ep.url || '';
    };
    sel.onchange = () => showEp(Number(sel.value) || 0);
    showEp(0);
  }
  const fw = $('#svc-firewall-cmd');
  if (fw && mobile.firewallCommand) fw.textContent = mobile.firewallCommand;
}

function setMobilePane(pane) {
  const shell = $('#app');
  if (!shell) return;
  const navPane = pane === 'agents' || pane === 'visual' ? 'inspector' : pane;
  shell.dataset.mobilePane = navPane;
  if (pane === 'agents') {
    document.querySelector('.tab-btn[data-tab="coordinator"]')?.click();
  } else if (pane === 'visual') {
    document.querySelector('.tab-btn[data-tab="companion"]')?.click();
  }
  $$('.mobile-nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mpane === pane);
  });
}

function renderExpertRosterList() {
  const list = $('#expert-roster-list');
  list.innerHTML = state.expertsRoster.map((e) => `
    <div class="modal-list-item ${e.id === state.selectedExpertId ? 'active' : ''}" data-eid="${escapeHtml(e.id)}">
      <div>${escapeHtml(e.name)}</div>
      <div class="small muted">${escapeHtml(e.category || 'Custom')}</div>
    </div>
  `).join('');
  list.querySelectorAll('.modal-list-item').forEach((el) => {
    el.addEventListener('click', () => selectExpertInModal(el.dataset.eid));
  });
}

function selectExpertInModal(id) {
  state.selectedExpertId = id;
  renderExpertRosterList();
  const e = state.expertsRoster.find((x) => x.id === id);
  const f = $('#form-expert');
  if (!e) {
    f.reset();
    f.elements.id.readOnly = false;
    return;
  }
  f.elements.id.value = e.id;
  f.elements.id.readOnly = true;
  f.elements.name.value = e.name;
  f.elements.category.value = e.category || '';
  f.elements.specialty.value = e.specialty || '';
  f.elements.systemPrompt.value = e.systemPrompt || '';
  f.elements.providerId.value = e.providerId || '';
  f.elements.model.value = e.model || '';
  f.elements.readOnly.checked = Boolean(e.readOnly);
  f.elements.allowVisualCompanion.checked = Boolean(e.allowVisualCompanion);
}

// ----- Event Wiring -----

$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'workspace') refreshWorkspaceStatus();
    if (btn.dataset.tab === 'companion') {
      if (state.loadedCompanionSessionId !== state.activeSessionId) reloadCompanionFrame();
      refreshWorkspaceImages();
    }
  });
});

$$('.modal-close').forEach((btn) => {
  btn.addEventListener('click', () => $(`#${btn.dataset.close}`).classList.add('hidden'));
});

$('#btn-dismiss-error').onclick = () => showSessionError('');
$('#btn-new-session').onclick = openNewSessionModal;
$('#btn-empty-new').onclick = openNewSessionModal;
$('#btn-providers').onclick = openProvidersModal;
$('#btn-empty-providers').onclick = openProvidersModal;
$('#btn-experts').onclick = openExpertsModal;
$('#btn-service').onclick = openServiceModal;
$('#btn-reload-companion').onclick = () => {
  if (state.visualMode === 'files') refreshWorkspaceImages();
  else reloadCompanionFrame();
};
$('#btn-visual-mode-screens').onclick = () => setVisualMode('screens');
$('#btn-visual-mode-files').onclick = () => setVisualMode('files');
$('#companion-screen-select').addEventListener('change', (e) => {
  reloadCompanionFrame(e.target.value);
});
$('#visual-files-filter').addEventListener('input', renderWorkspaceImagesGrid);
$('#btn-refresh-ws').onclick = refreshWorkspaceStatus;
$('#skill-search').addEventListener('input', renderSkillsTab);

$('#btn-expand-right').onclick = () => {
  const shell = $('#app');
  const expanded = shell.classList.toggle('expanded-right');
  $('#btn-expand-right').textContent = expanded ? 'Collapse' : 'Expand';
};

$('#btn-jump-coord').onclick = () => {
  document.querySelector('.tab-btn[data-tab="coordinator"]').click();
};

$('#btn-toggle-rules').onclick = () => {
  $('#rules-drawer').classList.toggle('hidden');
};
$('#btn-session-settings').onclick = openSessionSettingsModal;
$('#session-models-pill').style.cursor = 'pointer';
$('#session-models-pill').onclick = openSessionSettingsModal;
$('#btn-open-delete-session').onclick = () => {
  if (state.activeSessionId) openDeleteSessionModal(state.activeSessionId);
};
$('#chk-purge-branch').addEventListener('change', syncDeleteButtonLabel);
$('#chk-purge-workspace').addEventListener('change', syncDeleteButtonLabel);
$('#btn-confirm-delete-session').onclick = confirmDeleteSession;

$('#btn-save-rules').onclick = async () => {
  if (!state.activeSessionId) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}`, {
      method: 'PUT',
      body: JSON.stringify({
        rules: $('#rules-textarea').value,
        plan: $('#plan-textarea').value,
      }),
    });
    showToast('Rules & plan draft saved.', 'success', 2500);
    await loadSessionDetail(state.activeSessionId);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

async function approveActiveSession() {
  if (!state.activeSessionId) return;
  showSessionError('');
  const btn1 = $('#btn-approve');
  const btn2 = $('#btn-drawer-approve');
  btn1.disabled = true;
  btn2.disabled = true;
  const orig1 = btn1.textContent;
  btn1.textContent = 'Dispatching…';

  const payload = {
    rules: $('#rules-textarea').value,
    plan: $('#plan-textarea').value,
  };
  try {
    await api(`/api/sessions/${state.activeSessionId}/approve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    $('#rules-drawer').classList.add('hidden');
    document.querySelector('.tab-btn[data-tab="coordinator"]').click();
    showToast('Mission locked & dispatched to Coordinator!', 'success');
    await loadSessionDetail(state.activeSessionId);
  } catch (err) {
    if (err.status === 409 && err.data?.code === 'WORKSPACE_CONFLICT') {
      const ok = await showConfirmDialog('Workspace Conflict', `${err.message}\n\nProceed in the shared non-git folder anyway?`);
      if (ok) {
        await api(`/api/sessions/${state.activeSessionId}/approve`, {
          method: 'POST',
          body: JSON.stringify({ ...payload, allowSharedNonGit: true }),
        });
        $('#rules-drawer').classList.add('hidden');
        document.querySelector('.tab-btn[data-tab="coordinator"]').click();
        showToast('Mission dispatched to Coordinator!', 'success');
        await loadSessionDetail(state.activeSessionId);
      }
    } else {
      showSessionError(err.message);
      showToast(`Dispatch failed: ${err.message}`, 'error', 7000);
    }
  } finally {
    btn1.disabled = false;
    btn2.disabled = false;
    btn1.textContent = orig1;
  }
}

const wrapAction = (fn) => async () => {
  try { await fn(); } catch (err) {
    showSessionError(err.message || 'Action failed');
    showToast(err.message || 'Action failed', 'error');
  }
};

$('#btn-approve').onclick = wrapAction(approveActiveSession);
$('#btn-drawer-approve').onclick = wrapAction(approveActiveSession);
$('#btn-pause').onclick = wrapAction(async () => {
  await api(`/api/sessions/${state.activeSessionId}/pause`, { method: 'POST' });
  showToast('Coordinator pausing…', 'warn');
  await loadSessionDetail(state.activeSessionId);
});
$('#btn-resume').onclick = wrapAction(async () => {
  await api(`/api/sessions/${state.activeSessionId}/resume`, { method: 'POST' });
  showToast('Coordinator resumed.', 'success');
  await loadSessionDetail(state.activeSessionId);
});
$('#btn-stop').onclick = wrapAction(async () => {
  await api(`/api/sessions/${state.activeSessionId}/stop`, { method: 'POST' });
  showToast('Coordinator & active Experts stopped.', 'warn');
  await loadSessionDetail(state.activeSessionId);
});
$('#btn-reopen').onclick = wrapAction(async () => {
  await api(`/api/sessions/${state.activeSessionId}/reopen-interview`, { method: 'POST' });
  showToast('Interview phase re-opened.', 'info');
  await loadSessionDetail(state.activeSessionId);
});
$('#btn-toggle-uninterrupted').onclick = wrapAction(async () => {
  if (!state.activeSessionId || !state.activeDetail?.session) return;
  const current = state.activeDetail.session.uninterruptedMode !== false;
  const next = !current;
  await api(`/api/sessions/${state.activeSessionId}`, {
    method: 'PUT',
    body: JSON.stringify({ uninterruptedMode: next }),
  });
  showToast(
    next
      ? 'Auto-Continue ON — agents will run uninterrupted until 100% complete.'
      : 'Auto-Continue OFF — Coordinator will pause on turn cap or stalls.',
    next ? 'success' : 'info',
    3500
  );
  await loadSessionDetail(state.activeSessionId, { timeline: false });
});

$('#chk-auto-resume').addEventListener('change', async (e) => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ autoResumeOnRestart: e.target.checked }),
    });
    showToast(
      e.target.checked
        ? 'Auto-resume on server restart enabled.'
        : 'Auto-resume on server restart disabled.',
      'info',
      3000
    );
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#btn-toggle-win-service').onclick = wrapAction(async () => {
  const currentlyInstalled = Boolean(state.serviceInfo?.windowsService?.installed);
  const res = await api('/api/service/windows', {
    method: 'POST',
    body: JSON.stringify({ enabled: !currentlyInstalled }),
  });
  showToast(
    res.windowsService?.installed
      ? 'Windows background auto-start enabled (SuperpowersStudioBackground).'
      : 'Windows background auto-start disabled.',
    res.windowsService?.installed ? 'success' : 'info',
    4000
  );
  await refreshServiceModal();
});

$('#btn-toggle-win-icons').onclick = wrapAction(async () => {
  const currentlyInstalled = Boolean(state.serviceInfo?.windowsShortcuts?.installed);
  const desktop = $('#chk-icon-desktop')?.checked !== false;
  const startMenu = $('#chk-icon-startmenu')?.checked !== false;
  const res = await api('/api/service/shortcuts', {
    method: 'POST',
    body: JSON.stringify({ enabled: !currentlyInstalled, desktop, startMenu }),
  });
  showToast(
    res.windowsShortcuts?.installed
      ? 'Created Superpowers Studio icon(s) on Windows!'
      : 'Removed Superpowers Studio Windows icon(s).',
    res.windowsShortcuts?.installed ? 'success' : 'info',
    4000
  );
  await refreshServiceModal();
});

$('#btn-copy-svc-url').onclick = () => {
  const inp = $('#svc-url-input');
  if (!inp?.value) return;
  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(inp.value).then(
      () => showToast('Persistent Studio URL copied.', 'success', 2000),
      () => { inp.select?.(); showToast('Select and copy the URL above.', 'info', 2500); }
    );
  } else {
    inp.select?.();
    showToast('Select and copy the URL above.', 'info', 2500);
  }
};

$('#btn-toggle-mobile-access').onclick = wrapAction(async () => {
  const currentlyEnabled = Boolean(state.serviceInfo?.mobile?.enabled);
  const res = await api('/api/service/mobile', {
    method: 'POST',
    body: JSON.stringify({ enabled: !currentlyEnabled }),
  });
  showToast(
    res.mobile?.enabled
      ? (res.mobile.needsRestartToBind
          ? 'Mobile access enabled! Restart Studio once to bind to LAN / Tailscale.'
          : 'Mobile access is LIVE — scan the QR code from your phone!')
      : 'Mobile access disabled (localhost only after next restart).',
    res.mobile?.enabled ? 'success' : 'info',
    5000
  );
  await refreshServiceModal();
});

$('#btn-copy-mobile-url').onclick = () => {
  const inp = $('#mobile-url-input');
  if (!inp?.value) return;
  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(inp.value).then(
      () => showToast('Mobile URL copied.', 'success', 2000),
      () => { inp.select?.(); showToast('Select and copy the URL above.', 'info', 2500); }
    );
  } else {
    inp.select?.();
    showToast('Select and copy the URL above.', 'info', 2500);
  }
};

$$('.mobile-nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => setMobilePane(btn.dataset.mpane));
});

// Composer image upload, paste (Ctrl+V), and drag-and-drop
$('#btn-attach-image').onclick = () => $('#image-file-input').click();
$('#image-file-input').addEventListener('change', async (e) => {
  await handleImageFiles(e.target.files);
  e.target.value = '';
});
$('#composer-input').addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imgFiles = [];
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) imgFiles.push(f);
    }
  }
  if (imgFiles.length > 0) {
    e.preventDefault();
    await handleImageFiles(imgFiles);
  }
});
const compWrap = $('#composer-wrap');
compWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  compWrap.classList.add('drag-over');
});
compWrap.addEventListener('dragleave', () => compWrap.classList.remove('drag-over'));
compWrap.addEventListener('drop', async (e) => {
  e.preventDefault();
  compWrap.classList.remove('drag-over');
  if (e.dataTransfer?.files?.length) {
    await handleImageFiles(e.dataTransfer.files);
  }
});

// Send message to Subordinate
async function sendComposerMessage() {
  if (!state.activeSessionId) return;
  const input = $('#composer-input');
  const text = input.value.trim();
  const attachments = state.pendingAttachments.map(({ id, filename, mimeType, sizeBytes }) => ({
    id, filename, mimeType, sizeBytes,
  }));
  if (!text && attachments.length === 0) return;

  input.value = '';
  state.pendingAttachments = [];
  renderPendingAttachments();
  $('#slash-menu').classList.add('hidden');
  $('#btn-send').disabled = true;
  state.subordinateBusy = true;
  renderAgentsAndMissionTab();
  try {
    await api(`/api/sessions/${state.activeSessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: text || 'Please review the attached image(s).', attachments }),
    });
  } catch (err) {
    showSessionError(err.message);
    showToast(`Message failed: ${err.message}`, 'error', 7000);
  } finally {
    $('#btn-send').disabled = false;
    state.subordinateBusy = false;
    state.streamingText = '';
    state.streamingReasoning = '';
    renderStreaming();
    await loadSessionDetail(state.activeSessionId);
  }
}

$('#btn-send').onclick = sendComposerMessage;
$('#composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendComposerMessage();
  }
});

// /skill-name autocomplete
$('#composer-input').addEventListener('input', (e) => {
  const val = e.target.value;
  const menu = $('#slash-menu');
  const m = val.match(/^\/([a-z0-9-]*)$/i);
  if (!m) {
    menu.classList.add('hidden');
    return;
  }
  const q = m[1].toLowerCase();
  const hits = state.skills.filter((s) => s.name.includes(q));
  if (!hits.length) {
    menu.classList.add('hidden');
    return;
  }
  menu.innerHTML = hits.map((s) => `
    <div class="slash-item" data-sname="${escapeHtml(s.name)}">
      <strong>/${escapeHtml(s.name)}</strong> <span class="muted small">${escapeHtml(s.description)}</span>
    </div>
  `).join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('.slash-item').forEach((item) => {
    item.addEventListener('click', () => {
      $('#composer-input').value = `/${item.dataset.sname} `;
      menu.classList.add('hidden');
      $('#composer-input').focus();
    });
  });
});

// Form: New Session
$('#form-new-session').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.createIfMissing = e.target.elements.createIfMissing.checked;
    body.uninterruptedMode = e.target.elements.uninterruptedMode.checked;
    const { session } = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
    $('#modal-new-session').classList.add('hidden');
    e.target.reset();
    showToast(`Session "${session.title}" created.`, 'success', 2500);
    await refreshSessions();
    await selectSession(session.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Form: Edit Existing Session Settings
$('#form-session-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.activeSessionId) return;
  try {
    const f = e.target;
    const maxTurns = Math.max(1, Number(f.elements.maxTurns.value) || 100);
    const body = {
      title: f.elements.title.value.trim(),
      providerId: f.elements.providerId.value,
      model: f.elements.model.value.trim(),
      coordinatorProviderId: f.elements.coordinatorProviderId.value,
      coordinatorModel: f.elements.coordinatorModel.value.trim(),
      expertProviderId: f.elements.expertProviderId.value,
      expertModel: f.elements.expertModel.value.trim(),
      uninterruptedMode: f.elements.uninterruptedMode.checked,
      maxTurns,
    };
    await api(`/api/sessions/${state.activeSessionId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    $('#modal-session-settings').classList.add('hidden');
    showToast('Session settings saved — active on the next turn!', 'success', 3000);
    await refreshSessions();
    await loadSessionDetail(state.activeSessionId, { timeline: false });
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Form: Providers
function readProviderFormPayload() {
  const fd = new FormData($('#form-provider'));
  const body = Object.fromEntries(fd.entries());
  if (!body.apiKey) delete body.apiKey;
  return body;
}

$('#btn-add-provider').onclick = () => selectProviderInModal(null);
$('#form-provider').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = readProviderFormPayload();
    if (state.providers.some((p) => p.id === body.id)) {
      await api(`/api/providers/${encodeURIComponent(body.id)}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/providers', { method: 'POST', body: JSON.stringify(body) });
    }
    const res = await api('/api/providers');
    state.providers = res.providers;
    selectProviderInModal(body.id);
    $('#provider-test-result').textContent = 'Saved.';
    showToast(`Provider "${body.name}" saved.`, 'success', 2500);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#btn-delete-provider').onclick = async () => {
  const id = $('#form-provider').elements.id.value;
  if (!id) return;
  if (!(await showConfirmDialog('Delete Provider', `Delete provider "${id}"?`))) return;
  try {
    await api(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const res = await api('/api/providers');
    state.providers = res.providers;
    selectProviderInModal(state.providers[0]?.id || null);
    showToast(`Provider "${id}" deleted.`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

$('#btn-fetch-models').onclick = async () => {
  const body = readProviderFormPayload();
  if (!body.id) return;
  $('#provider-test-result').textContent = 'Fetching models…';
  try {
    const { models } = await api(`/api/providers/${encodeURIComponent(body.id)}/models`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    $('#dl-prov-models').innerHTML = (models || []).map((m) => `<option value="${escapeHtml(m)}">`).join('');
    $('#provider-test-result').textContent = `Loaded ${models.length} models.`;
  } catch (err) {
    $('#provider-test-result').textContent = `Error: ${err.message}`;
  }
};

$('#btn-test-provider').onclick = async () => {
  const body = readProviderFormPayload();
  if (!body.id) return;
  $('#provider-test-result').textContent = 'Testing…';
  try {
    const res = await api(`/api/providers/${encodeURIComponent(body.id)}/test`, {
      method: 'POST',
      body: JSON.stringify({ ...body, model: body.defaultModel }),
    });
    $('#provider-test-result').textContent = `${res.ok ? '✓' : '✗'} ${res.message} (${res.latencyMs}ms)`;
  } catch (err) {
    $('#provider-test-result').textContent = `✗ ${err.message}`;
  }
};

// Form: Expert Roster
$('#btn-add-expert').onclick = () => selectExpertInModal(null);
$('#form-expert').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const f = e.target;
    const body = {
      id: f.elements.id.value,
      name: f.elements.name.value,
      category: f.elements.category.value,
      specialty: f.elements.specialty.value,
      systemPrompt: f.elements.systemPrompt.value,
      providerId: f.elements.providerId.value,
      model: f.elements.model.value,
      readOnly: f.elements.readOnly.checked,
      allowVisualCompanion: f.elements.allowVisualCompanion.checked,
    };
    const { expert } = await api('/api/experts', { method: 'POST', body: JSON.stringify(body) });
    const res = await api('/api/experts');
    state.expertsRoster = res.experts;
    $('#btn-experts').textContent = `Expert Roster (${state.expertsRoster.length})`;
    selectExpertInModal(expert?.id || body.id);
    showToast(`Expert "${body.name}" saved.`, 'success', 2500);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('#btn-delete-expert').onclick = async () => {
  const id = $('#form-expert').elements.id.value;
  if (!id) return;
  if (!(await showConfirmDialog('Delete Expert', `Delete expert "${id}"?`))) return;
  try {
    await api(`/api/experts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const res = await api('/api/experts');
    state.expertsRoster = res.experts;
    $('#btn-experts').textContent = `Expert Roster (${state.expertsRoster.length})`;
    selectExpertInModal(state.expertsRoster[0]?.id || null);
    showToast(`Expert "${id}" deleted.`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

initPaneResizers();
connectWebSocket();
bootstrap().catch((err) => showToast(`Failed to initialize Studio: ${err.message}`, 'error', 10000));
