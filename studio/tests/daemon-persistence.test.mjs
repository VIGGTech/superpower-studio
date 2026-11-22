import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../lib/store.mjs';
import { createStudioServer } from '../server.mjs';
import {
  startDaemon,
  stopDaemon,
  restartDaemon,
  getDaemonStatus,
  readDaemonLogs,
  installWindowsService,
  uninstallWindowsService,
  getWindowsServiceStatus,
  buildStudioIcoBuffer,
  installWindowsShortcuts,
  uninstallWindowsShortcuts,
  getWindowsShortcutsStatus,
} from '../lib/daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-daemon-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Timed out waiting for condition');
}

test('persistToken reuses the same auth token across server restarts', async () => {
  const dataDir = makeTempDir('sp-tok-');
  try {
    const s1 = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1', persistToken: true });
    const tok1 = s1.token;
    await s1.close();

    assert.equal(fs.existsSync(path.join(dataDir, 'auth.token')), true);

    const s2 = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1', persistToken: true });
    const tok2 = s2.token;
    await s2.close();

    assert.equal(tok2, tok1, 'Expected persistent auth token to survive server restart');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('autoResume on restart resumes uninterruptedMode sessions while keeping capped sessions paused', async () => {
  const base = makeTempDir('sp-autoresume-');
  const dataDir = path.join(base, 'data');
  const work1 = path.join(base, 'w1');
  const work2 = path.join(base, 'w2');
  fs.mkdirSync(work1, { recursive: true });
  fs.mkdirSync(work2, { recursive: true });

  try {
    // Seed two interrupted running sessions on disk (simulating a server crash/restart)
    const store = createStore({ dataDir });
    const sAuto = store.createSession({
      title: 'Uninterrupted Job',
      workspacePath: work1,
      providerId: 'abliteration',
      model: 'm1',
      uninterruptedMode: true,
    });
    store.updateSession(sAuto.id, {
      phase: 'running',
      rules: '- Keep going',
      plan: '1. Finish artifact',
      tasks: [{ id: 'task-1', title: 'Finish artifact', status: 'in_progress' }],
    });
    store.saveCoordinator(sAuto.id, {
      status: 'running',
      turnCount: 4,
      messages: [
        { role: 'user', content: 'Begin mission' },
        { role: 'assistant', content: 'Running tool', toolCalls: [{ id: 'tc_dangling', name: 'list_files', arguments: {} }] },
      ],
    });

    const sCapped = store.createSession({
      title: 'Capped Job',
      workspacePath: work2,
      providerId: 'abliteration',
      model: 'm1',
      uninterruptedMode: false,
    });
    store.updateSession(sCapped.id, {
      phase: 'running',
      rules: '- Capped',
      plan: '1. Wait for manual resume',
      tasks: [{ id: 'task-1', title: 'Wait', status: 'pending' }],
    });
    store.saveCoordinator(sCapped.id, { status: 'running', turnCount: 2, messages: [{ role: 'user', content: 'Go' }] });

    const resumedIds = new Set();
    const studio = await createStudioServer({
      dataDir,
      skillsRoot: SKILLS_ROOT,
      port: 0,
      host: '127.0.0.1',
      autoResume: true,
      streamChatImpl: async ({ systemPrompt, messages }) => {
        if (systemPrompt.includes('Role: Coordinator')) {
          if (systemPrompt.includes('Keep going')) resumedIds.add(sAuto.id);
          if (systemPrompt.includes('Capped')) resumedIds.add(sCapped.id);
          // Verify dangling tool call was closed before resume
          const hasClosure = messages.some((m) => m.role === 'tool' && m.toolCallId === 'tc_dangling');
          assert.equal(hasClosure, true, 'Dangling tool call must be closed before auto-resume');
          return {
            content: 'Finishing up after restart',
            reasoning: '',
            toolCalls: [
              { id: 'tc_p', name: 'update_task_progress', arguments: { taskId: 'task-1', status: 'done' } },
              { id: 'tc_f', name: 'report_complete', arguments: { summary: 'Recovered & done', verification: 'OK' } },
            ],
          };
        }
        return { content: 'Auto-resumed and completed!', reasoning: '', toolCalls: [] };
      },
    });

    try {
      await waitFor(() => studio.store.getSession(sAuto.id).phase === 'completed', 5000);
      assert.equal(resumedIds.has(sAuto.id), true);
      assert.equal(resumedIds.has(sCapped.id), false);
      assert.equal(studio.store.getSession(sCapped.id).phase, 'paused');

      // Verify /api/health works unauthenticated
      const health = await (await fetch(`http://127.0.0.1:${studio.port}/api/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.pid, process.pid);
    } finally {
      await studio.close();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('detached daemon start, idempotent start, status, logs, and stop work end-to-end', async () => {
  const dataDir = makeTempDir('sp-dproc-');
  const port = await getFreePort();
  try {
    const started = await startDaemon({ dataDir, port, host: '127.0.0.1', startupTimeoutMs: 8000 });
    assert.equal(started.ok, true);
    assert.equal(started.alreadyRunning, false);
    assert.ok(started.pid > 0);
    assert.match(started.url, new RegExp(`http://localhost:${port}/\\?token=`));

    // Health check responds live from the detached process
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.pid, started.pid);

    // Calling startDaemon again is idempotent
    const second = await startDaemon({ dataDir, port, host: '127.0.0.1' });
    assert.equal(second.alreadyRunning, true);
    assert.equal(second.pid, started.pid);

    // Status & logs
    const st = await getDaemonStatus({ dataDir });
    assert.equal(st.running, true);
    assert.equal(st.pid, started.pid);
    const logs = readDaemonLogs({ dataDir, lines: 20 });
    assert.match(logs, /studio-started/);

    // Stop cleanly
    const stopped = await stopDaemon({ dataDir });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stoppedPid, started.pid);

    const after = await getDaemonStatus({ dataDir });
    assert.equal(after.running, false);
  } finally {
    try { await stopDaemon({ dataDir }); } catch { /* ignore */ }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  }
});

test('Windows background service install, status, and uninstall build safe schtasks commands & hidden VBS launcher', () => {
  const dataDir = makeTempDir('sp-winsvc-');
  try {
    const calls = [];
    let installed = false;
    const fakeExec = (file, args) => {
      calls.push({ file, args });
      if (file === 'reg.exe') {
        if (args[0] === 'query') throw Object.assign(new Error('ERROR: The system was unable to find the specified registry key or value.'), { status: 1 });
        return '';
      }
      if (args.includes('/Create')) {
        installed = true;
        return 'SUCCESS: The scheduled task "SuperpowersStudioBackground" has successfully been created.';
      }
      if (args.includes('/Query')) {
        if (!installed) throw Object.assign(new Error('ERROR: The system cannot find the file specified.'), { status: 1 });
        return 'TaskName: \\SuperpowersStudioBackground\nStatus: Ready';
      }
      if (args.includes('/Delete')) {
        installed = false;
        return 'SUCCESS: The scheduled task "SuperpowersStudioBackground" was successfully deleted.';
      }
      return '';
    };

    const st0 = getWindowsServiceStatus({ platform: 'win32', execFileSyncImpl: fakeExec });
    assert.equal(st0.supported, true);
    assert.equal(st0.installed, false);

    const ins = installWindowsService({
      dataDir,
      port: 49500,
      host: '127.0.0.1',
      platform: 'win32',
      execFileSyncImpl: fakeExec,
    });
    assert.equal(ins.installed, true);
    assert.equal(fs.existsSync(ins.launcherPath), true);
    const vbs = fs.readFileSync(ins.launcherPath, 'utf8');
    assert.match(vbs, /WScript\.Shell/);
    assert.match(vbs, /daemon\.mjs/);
    assert.ok(calls.some((c) => c.file === 'schtasks.exe' && c.args.includes('/Create') && c.args.includes('ONLOGON')));

    const st1 = getWindowsServiceStatus({ platform: 'win32', execFileSyncImpl: fakeExec });
    assert.equal(st1.installed, true);

    const un = uninstallWindowsService({ dataDir, platform: 'win32', execFileSyncImpl: fakeExec });
    assert.equal(un.installed, false);
    assert.equal(fs.existsSync(ins.launcherPath), false);
    assert.ok(calls.some((c) => c.file === 'schtasks.exe' && c.args.includes('/Delete')));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Windows background service falls back to zero-admin HKCU Run registry when schtasks fails with Access Denied', () => {
  const dataDir = makeTempDir('sp-winsvc-reg-');
  try {
    let regValue = null;
    const calls = [];
    const fakeNonAdminExec = (file, args) => {
      calls.push({ file, args });
      if (file === 'schtasks.exe') {
        throw Object.assign(new Error('ERROR: Access is denied.'), { status: 1 });
      }
      if (file === 'reg.exe') {
        if (args[0] === 'add') {
          regValue = args[args.indexOf('/d') + 1];
          return 'The operation completed successfully.';
        }
        if (args[0] === 'query') {
          if (!regValue) throw Object.assign(new Error('not found'), { status: 1 });
          return `    SuperpowersStudioBackground    REG_SZ    ${regValue}`;
        }
        if (args[0] === 'delete') {
          regValue = null;
          return 'The operation completed successfully.';
        }
      }
      return '';
    };

    const st0 = getWindowsServiceStatus({ platform: 'win32', execFileSyncImpl: fakeNonAdminExec });
    assert.equal(st0.installed, false);

    const ins = installWindowsService({
      dataDir,
      port: 49500,
      platform: 'win32',
      execFileSyncImpl: fakeNonAdminExec,
    });
    assert.equal(ins.installed, true);
    assert.equal(ins.method, 'registry-run');
    assert.ok(regValue && regValue.includes('launch-studio-hidden.vbs'));

    const st1 = getWindowsServiceStatus({ platform: 'win32', execFileSyncImpl: fakeNonAdminExec });
    assert.equal(st1.installed, true);
    assert.equal(st1.method, 'registry-run');

    const un = uninstallWindowsService({ dataDir, platform: 'win32', execFileSyncImpl: fakeNonAdminExec });
    assert.equal(un.installed, false);
    assert.equal(regValue, null);
    assert.equal(fs.existsSync(ins.launcherPath), false);
    assert.ok(calls.some((c) => c.file === 'reg.exe' && c.args[0] === 'delete'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('HTTP /api/service and POST /api/service/windows expose background status and toggle optional Windows service', async () => {
  const dataDir = makeTempDir('sp-svcapi-');
  let installed = false;
  const studio = await createStudioServer({
    dataDir,
    skillsRoot: SKILLS_ROOT,
    port: 0,
    host: '127.0.0.1',
    windowsServiceController: {
      status: () => ({ supported: true, installed, taskName: 'SuperpowersStudioBackground', platform: 'win32' }),
      install: () => { installed = true; return { supported: true, installed: true, taskName: 'SuperpowersStudioBackground', platform: 'win32' }; },
      uninstall: () => { installed = false; return { supported: true, installed: false, taskName: 'SuperpowersStudioBackground', platform: 'win32' }; },
    },
  });
  const base = `http://127.0.0.1:${studio.port}`;
  try {
    const boot = await fetch(`${base}/?token=${studio.token}`);
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };

    const s1 = await (await fetch(`${base}/api/service`, { headers })).json();
    assert.equal(s1.autoResumeOnRestart, true);
    assert.equal(s1.windowsService.installed, false);

    const on = await (await fetch(`${base}/api/service/windows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true }),
    })).json();
    assert.equal(on.windowsService.installed, true);

    const off = await (await fetch(`${base}/api/service/windows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    })).json();
    assert.equal(off.windowsService.installed, false);
  } finally {
    await studio.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Windows One-Click Icon generates valid ICO, hidden open VBS launcher, and Desktop/Start Menu shortcuts + HTTP /api/service/shortcuts', async () => {
  const baseDir = makeTempDir('sp-winicon-');
  const dataDir = path.join(baseDir, 'data');
  const desktopDir = path.join(baseDir, 'Desktop');
  const startMenuDir = path.join(baseDir, 'StartMenu');
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(startMenuDir, { recursive: true });

  try {
    // 1. Valid 32x32 Windows .ico binary header
    const ico = buildStudioIcoBuffer();
    assert.ok(Buffer.isBuffer(ico) && ico.length > 1000);
    assert.equal(ico.readUInt16LE(0), 0); // reserved
    assert.equal(ico.readUInt16LE(2), 1); // type = ICO
    assert.equal(ico.readUInt16LE(4), 1); // count = 1 image
    assert.equal(ico[6], 32); // width 32
    assert.equal(ico[7], 32); // height 32

    // 2. Install & uninstall shortcuts via injectable cscript runner
    const ranScripts = [];
    const fakeExec = (file, args) => {
      const scriptPath = args.find((a) => String(a).endsWith('.vbs'));
      const content = scriptPath && fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
      ranScripts.push({ file, args, content });
      // Simulate WScript creating the .lnk targets mentioned in the script
      for (const m of content.matchAll(/CreateShortcut\("([^"]+)"\)/g)) {
        fs.writeFileSync(m[1], 'MOCK_LNK');
      }
      return '';
    };

    const st0 = getWindowsShortcutsStatus({ desktopDir, startMenuDir, platform: 'win32' });
    assert.equal(st0.supported, true);
    assert.equal(st0.installed, false);

    const ins = installWindowsShortcuts({
      dataDir,
      port: 49500,
      host: '127.0.0.1',
      desktop: true,
      startMenu: true,
      desktopDir,
      startMenuDir,
      platform: 'win32',
      execFileSyncImpl: fakeExec,
    });
    assert.equal(ins.installed, true);
    assert.equal(ins.desktop.exists, true);
    assert.equal(ins.startMenu.exists, true);
    assert.equal(fs.existsSync(ins.launcherPath), true);
    assert.equal(fs.existsSync(ins.iconPath), true);
    const vbs = fs.readFileSync(ins.launcherPath, 'utf8');
    assert.match(vbs, /daemon\.mjs""\s+open/);
    assert.ok(ranScripts.some((r) => r.file === 'cscript.exe' && r.content.includes('Superpowers Studio.lnk')));

    const un = uninstallWindowsShortcuts({ dataDir, desktopDir, startMenuDir, platform: 'win32' });
    assert.equal(un.installed, false);
    assert.equal(un.desktop.exists, false);
    assert.equal(un.startMenu.exists, false);
    assert.equal(fs.existsSync(ins.launcherPath), false);

    // 3. HTTP /api/service/shortcuts endpoint
    let scInstalled = false;
    const studio = await createStudioServer({
      dataDir,
      skillsRoot: SKILLS_ROOT,
      port: 0,
      host: '127.0.0.1',
      windowsShortcutsController: {
        status: () => ({ supported: true, installed: scInstalled, desktop: { exists: scInstalled, path: 'D' }, startMenu: { exists: scInstalled, path: 'S' } }),
        install: () => { scInstalled = true; return { supported: true, installed: true, desktop: { exists: true, path: 'D' }, startMenu: { exists: true, path: 'S' } }; },
        uninstall: () => { scInstalled = false; return { supported: true, installed: false, desktop: { exists: false, path: 'D' }, startMenu: { exists: false, path: 'S' } }; },
      },
    });
    const base = `http://127.0.0.1:${studio.port}`;
    try {
      const boot = await fetch(`${base}/?token=${studio.token}`);
      const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
      const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };

      const on = await (await fetch(`${base}/api/service/shortcuts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: true, desktop: true, startMenu: true }),
      })).json();
      assert.equal(on.windowsShortcuts.installed, true);

      const svc = await (await fetch(`${base}/api/service`, { headers })).json();
      assert.equal(svc.windowsShortcuts.installed, true);

      const off = await (await fetch(`${base}/api/service/shortcuts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: false }),
      })).json();
      assert.equal(off.windowsShortcuts.installed, false);
    } finally {
      await studio.close();
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('POST /api/service/restart returns 202, persists token, and restartDaemon spawns fresh detached PID', async () => {
  const dataDir = makeTempDir('sp-restart-');
  let restartCalledWith = null;
  const studio = await createStudioServer({
    dataDir,
    skillsRoot: SKILLS_ROOT,
    port: 0,
    host: '127.0.0.1',
    token: 'restart-persist-token',
    serviceRestarter: (opts) => {
      restartCalledWith = opts;
    },
  });
  const base = `http://127.0.0.1:${studio.port}`;
  try {
    const boot = await fetch(`${base}/?token=${studio.token}`);
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };

    const res = await fetch(`${base}/api/service/restart`, { method: 'POST', headers });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.restarting, true);
    assert.equal(body.previousPid, process.pid);
    assert.ok(restartCalledWith && restartCalledWith.port === studio.port && restartCalledWith.dataDir === dataDir);

    // Token must be persisted so browser reconnects with zero 403
    const savedTok = fs.readFileSync(path.join(dataDir, 'auth.token'), 'utf8').trim();
    assert.equal(savedTok, 'restart-persist-token');
  } finally {
    await studio.close();
  }

  // Real detached daemon start -> restartDaemon -> verify fresh PID & healthy
  const port = await getFreePort();
  try {
    const s1 = await startDaemon({ dataDir, port, host: '127.0.0.1' });
    assert.equal(s1.running, true);
    const s2 = await restartDaemon({ dataDir, port, host: '127.0.0.1' });
    assert.equal(s2.running, true);
    assert.notEqual(s2.pid, s1.pid);
  } finally {
    await stopDaemon({ dataDir });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
