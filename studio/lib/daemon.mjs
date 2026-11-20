import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
export const SERVER_ENTRY = path.join(STUDIO_ROOT, 'server.mjs');
export const DAEMON_CLI = path.join(STUDIO_ROOT, 'daemon.mjs');
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, '.superpowers-studio');
export const WINDOWS_TASK_NAME = 'SuperpowersStudioBackground';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function resolvePersistentToken(dataDir, explicitToken = '') {
  ensureDir(dataDir);
  const tokenFile = path.join(dataDir, 'auth.token');
  const trimmedExplicit = String(explicitToken || '').trim();
  if (trimmedExplicit) {
    if (!fs.existsSync(tokenFile)) {
      try { fs.writeFileSync(tokenFile, trimmedExplicit, { mode: 0o600 }); } catch { /* ignore */ }
    }
    return trimmedExplicit;
  }
  if (fs.existsSync(tokenFile)) {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenFile, fresh, { mode: 0o600 });
  return fresh;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function probeHealth(host, port, timeoutMs = 1500) {
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${probeHost}:${port}/api/health`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getDaemonStatus({ dataDir = DEFAULT_DATA_DIR } = {}) {
  const stateFile = path.join(dataDir, 'daemon.json');
  const logFile = path.join(dataDir, 'daemon.log');
  const info = readJsonSafe(stateFile, null);
  if (!info || !info.pid) {
    return { running: false, pid: null, port: null, host: null, url: null, logFile, stateFile };
  }
  const alive = isPidAlive(info.pid);
  if (!alive) {
    try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
    return { running: false, pid: null, port: info.port || null, host: info.host || null, url: null, logFile, stateFile };
  }
  const health = await probeHealth(info.host || '127.0.0.1', info.port || 49500);
  if (health && health.pid && health.pid !== info.pid) {
    // Another process owns the port, stale PID file
    return { running: false, pid: null, port: info.port, host: info.host, url: null, logFile, stateFile, stale: true };
  }
  return {
    running: true,
    pid: info.pid,
    port: info.port,
    host: info.host,
    url: info.url,
    startedAt: info.startedAt,
    uptimeSec: health?.uptimeSec ?? null,
    logFile,
    stateFile,
  };
}

export async function startDaemon({
  dataDir = DEFAULT_DATA_DIR,
  port = Number(process.env.SUPERPOWERS_STUDIO_PORT) || 49500,
  host = process.env.SUPERPOWERS_STUDIO_HOST || '',
  token = process.env.SUPERPOWERS_STUDIO_TOKEN || '',
  startupTimeoutMs = 10000,
} = {}) {
  ensureDir(dataDir);
  if (!host) {
    const sRaw = readJsonSafe(path.join(dataDir, 'settings.json'), {});
    host = sRaw?.remoteAccessEnabled ? '0.0.0.0' : '127.0.0.1';
  }
  const existing = await getDaemonStatus({ dataDir });
  if (existing.running) {
    return { ok: true, alreadyRunning: true, ...existing };
  }

  const persistentToken = resolvePersistentToken(dataDir, token);
  const stateFile = path.join(dataDir, 'daemon.json');
  const logFile = path.join(dataDir, 'daemon.log');
  const logFd = fs.openSync(logFile, 'a');

  const env = {
    ...process.env,
    SUPERPOWERS_STUDIO_DATA_DIR: dataDir,
    SUPERPOWERS_STUDIO_PORT: String(port),
    SUPERPOWERS_STUDIO_HOST: host,
    SUPERPOWERS_STUDIO_TOKEN: persistentToken,
    SUPERPOWERS_STUDIO_PERSIST_TOKEN: '1',
    SUPERPOWERS_STUDIO_DETACHED: '1',
  };

  let child;
  try {
    child = spawn(process.execPath, [SERVER_ENTRY, '--port', String(port), '--host', host], {
      cwd: REPO_ROOT,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
  } finally {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  }

  const deadline = Date.now() + startupTimeoutMs;
  let health = null;
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid)) {
      throw new Error(`Studio daemon exited immediately. Check logs at ${logFile}`);
    }
    health = await probeHealth(host, port, 1000);
    if (health?.ok && health.pid === child.pid) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!health?.ok) {
    try { process.kill(child.pid); } catch { /* ignore */ }
    throw new Error(`Studio daemon failed to become healthy within ${startupTimeoutMs}ms. Check logs at ${logFile}`);
  }

  const displayHost = (host === '127.0.0.1' || host === '0.0.0.0' || host === '::') ? 'localhost' : host;
  const url = `http://${displayHost}:${port}/?token=${persistentToken}`;
  const state = {
    pid: child.pid,
    port,
    host,
    url,
    startedAt: new Date().toISOString(),
    logFile,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  return { ok: true, alreadyRunning: false, running: true, ...state };
}

export async function stopDaemon({ dataDir = DEFAULT_DATA_DIR, platform = process.platform } = {}) {
  const stateFile = path.join(dataDir, 'daemon.json');
  const info = readJsonSafe(stateFile, null);
  if (!info || !info.pid) {
    return { ok: true, stoppedPid: null, wasRunning: false };
  }
  const pid = info.pid;
  const wasRunning = isPidAlive(pid);

  if (wasRunning) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* ignore */ }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isPidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidAlive(pid)) {
      if (platform === 'win32') {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch { /* ignore */ }
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }
  }

  try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  return { ok: true, stoppedPid: pid, wasRunning };
}

export function readDaemonLogs({ dataDir = DEFAULT_DATA_DIR, lines = 80 } = {}) {
  const logFile = path.join(dataDir, 'daemon.log');
  if (!fs.existsSync(logFile)) return '';
  const raw = fs.readFileSync(logFile, 'utf8');
  const all = raw.split(/\r?\n/);
  return all.slice(-Math.max(1, Number(lines) || 80)).join('\n');
}

function escapeVbsString(str) {
  return String(str).replace(/"/g, '""');
}

export function getWindowsServiceStatus({
  taskName = WINDOWS_TASK_NAME,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== 'win32') {
    return { supported: false, installed: false, taskName, platform, reason: 'Windows Task Scheduler auto-start is only available on Windows.' };
  }
  try {
    const out = execFileSyncImpl('schtasks.exe', ['/Query', '/TN', taskName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { supported: true, installed: true, taskName, platform, detail: String(out || '').trim().slice(0, 300) };
  } catch {
    return { supported: true, installed: false, taskName, platform };
  }
}

export function installWindowsService({
  dataDir = DEFAULT_DATA_DIR,
  port = 49500,
  host = '',
  taskName = WINDOWS_TASK_NAME,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== 'win32') {
    throw new Error('Windows background service auto-start can only be installed on Windows.');
  }
  ensureDir(dataDir);
  const launcherPath = path.join(dataDir, 'launch-studio-hidden.vbs');
  const nodeExe = process.execPath;
  const hostArg = host ? ` --host ${String(host)}` : '';
  const cmd = `"${nodeExe}" "${DAEMON_CLI}" start --port ${Number(port) || 49500}${hostArg}`;
  const vbsContent = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Environment("Process")("SUPERPOWERS_STUDIO_DATA_DIR") = "${escapeVbsString(dataDir)}"`,
    `WshShell.CurrentDirectory = "${escapeVbsString(REPO_ROOT)}"`,
    `WshShell.Run "${escapeVbsString(cmd)}", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(launcherPath, vbsContent, 'utf8');

  execFileSyncImpl(
    'schtasks.exe',
    ['/Create', '/TN', taskName, '/TR', `wscript.exe "${launcherPath}"`, '/SC', 'ONLOGON', '/F'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  return {
    supported: true,
    installed: true,
    taskName,
    launcherPath,
    platform,
  };
}

export function uninstallWindowsService({
  dataDir = DEFAULT_DATA_DIR,
  taskName = WINDOWS_TASK_NAME,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== 'win32') {
    return { supported: false, installed: false, taskName, platform };
  }
  try {
    execFileSyncImpl('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    // Task may already be absent
  }
  const launcherPath = path.join(dataDir, 'launch-studio-hidden.vbs');
  try {
    if (fs.existsSync(launcherPath)) fs.unlinkSync(launcherPath);
  } catch { /* ignore */ }
  return {
    supported: true,
    installed: false,
    taskName,
    launcherPath,
    platform,
  };
}

export function buildStudioIcoBuffer() {
  const w = 32;
  const h = 32;
  const headerSize = 6 + 16; // ICONDIR + 1 ICONDIRENTRY
  const dibHeaderSize = 40;
  const pixelBytes = w * h * 4;
  const andMaskBytes = (w / 8) * h; // 4 bytes per row * 32 = 128
  const imageSize = dibHeaderSize + pixelBytes + andMaskBytes;
  const buf = Buffer.alloc(headerSize + imageSize);

  // ICONDIR
  buf.writeUInt16LE(0, 0); // reserved
  buf.writeUInt16LE(1, 2); // type 1 = ICO
  buf.writeUInt16LE(1, 4); // 1 image

  // ICONDIRENTRY
  buf[6] = w;
  buf[7] = h;
  buf[8] = 0; // colors
  buf[9] = 0; // reserved
  buf.writeUInt16LE(1, 10); // planes
  buf.writeUInt16LE(32, 12); // bpp
  buf.writeUInt32LE(imageSize, 14);
  buf.writeUInt32LE(headerSize, 18);

  // BITMAPINFOHEADER
  let off = headerSize;
  buf.writeUInt32LE(dibHeaderSize, off);
  buf.writeInt32LE(w, off + 4);
  buf.writeInt32LE(h * 2, off + 8); // XOR + AND mask height
  buf.writeUInt16LE(1, off + 12); // planes
  buf.writeUInt16LE(32, off + 14); // 32-bit BGRA
  buf.writeUInt32LE(0, off + 16); // BI_RGB
  buf.writeUInt32LE(pixelBytes + andMaskBytes, off + 20);
  off += dibHeaderSize;

  // Draw rounded blue badge with white lightning bolt + emerald active dot (bottom-up rows)
  const setPx = (x, y, r, g, b, a) => {
    const row = h - 1 - y;
    const idx = off + (row * w + x) * 4;
    buf[idx] = b;
    buf[idx + 1] = g;
    buf[idx + 2] = r;
    buf[idx + 3] = a;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Rounded square mask (radius 7)
      const cx = Math.min(Math.max(x, 7), w - 8);
      const cy = Math.min(Math.max(y, 7), h - 8);
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > 7.4) {
        setPx(x, y, 0, 0, 0, 0);
        continue;
      }
      // Smooth gradient from #0071e3 (top-left) to #0b4fa8 (bottom-right)
      const t = (x + y) / (w + h);
      let r = Math.round(0 + t * 14);
      let g = Math.round(126 - t * 44);
      let b = Math.round(238 - t * 52);

      // Subtle white lightning bolt in center
      const inUpperBolt = y >= 5 && y <= 17 && x >= Math.round(18 - (y - 5) * 0.72) && x <= Math.round(21 - (y - 5) * 0.48);
      const inMidBar = y >= 14 && y <= 17 && x >= 9 && x <= 23;
      const inLowerBolt = y >= 15 && y <= 26 && x >= Math.round(17 - (y - 15) * 0.55) && x <= Math.round(22 - (y - 15) * 0.75);
      if (inUpperBolt || inMidBar || inLowerBolt) {
        r = 255; g = 255; b = 255;
      }

      // Live emerald status dot in bottom-right corner
      if (Math.hypot(x - 24, y - 24) <= 3.3) {
        r = 52; g = 199; b = 89;
      }
      setPx(x, y, r, g, b, 255);
    }
  }

  return buf;
}

export function openBrowserUrl(url, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }
  const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function openStudio({
  dataDir = DEFAULT_DATA_DIR,
  port = Number(process.env.SUPERPOWERS_STUDIO_PORT) || 49500,
  host = process.env.SUPERPOWERS_STUDIO_HOST || '127.0.0.1',
  token = process.env.SUPERPOWERS_STUDIO_TOKEN || '',
  platform = process.platform,
} = {}) {
  const health = await probeHealth(host, port, 1200);
  let url;
  let startedNow = false;
  if (health?.ok) {
    const persistentToken = resolvePersistentToken(dataDir, token);
    const displayHost = (host === '127.0.0.1' || host === '0.0.0.0' || host === '::') ? 'localhost' : host;
    url = `http://${displayHost}:${port}/?token=${persistentToken}`;
  } else {
    const res = await startDaemon({ dataDir, port, host, token });
    url = res.url;
    startedNow = true;
  }
  openBrowserUrl(url, { platform });
  return { ok: true, url, startedNow };
}

function defaultShortcutDirs() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return {
    desktopDir: path.join(home, 'Desktop'),
    startMenuDir: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  };
}

export function getWindowsShortcutsStatus({
  desktopDir,
  startMenuDir,
  platform = process.platform,
} = {}) {
  const defs = defaultShortcutDirs();
  const dDir = desktopDir || defs.desktopDir;
  const sDir = startMenuDir || defs.startMenuDir;
  const desktopPath = path.join(dDir, 'Superpowers Studio.lnk');
  const startMenuPath = path.join(sDir, 'Superpowers Studio.lnk');
  if (platform !== 'win32') {
    return {
      supported: false,
      installed: false,
      desktop: { path: desktopPath, exists: false },
      startMenu: { path: startMenuPath, exists: false },
      platform,
    };
  }
  const desktopExists = fs.existsSync(desktopPath);
  const startMenuExists = fs.existsSync(startMenuPath);
  return {
    supported: true,
    installed: desktopExists || startMenuExists,
    desktop: { path: desktopPath, exists: desktopExists },
    startMenu: { path: startMenuPath, exists: startMenuExists },
    platform,
  };
}

export function installWindowsShortcuts({
  dataDir = DEFAULT_DATA_DIR,
  port = 49500,
  host = '',
  desktop = true,
  startMenu = true,
  desktopDir,
  startMenuDir,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== 'win32') {
    throw new Error('Windows shortcuts can only be created on Windows.');
  }
  ensureDir(dataDir);
  const defs = defaultShortcutDirs();
  const dDir = desktopDir || defs.desktopDir;
  const sDir = startMenuDir || defs.startMenuDir;

  // 1. Write custom .ico icon
  const iconPath = path.join(dataDir, 'superpowers-studio.ico');
  fs.writeFileSync(iconPath, buildStudioIcoBuffer());

  // 2. Write hidden VBS launcher that starts Studio if needed and opens browser
  const launcherPath = path.join(dataDir, 'open-studio-hidden.vbs');
  const nodeExe = process.execPath;
  const hostArg = host ? ` --host ${String(host)}` : '';
  const openCmd = `"${nodeExe}" "${DAEMON_CLI}" open --port ${Number(port) || 49500}${hostArg}`;
  const vbsLauncher = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Environment("Process")("SUPERPOWERS_STUDIO_DATA_DIR") = "${escapeVbsString(dataDir)}"`,
    `WshShell.CurrentDirectory = "${escapeVbsString(REPO_ROOT)}"`,
    `WshShell.Run "${escapeVbsString(openCmd)}", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(launcherPath, vbsLauncher, 'utf8');

  // 3. Create .lnk files via WScript.Shell.CreateShortcut (zero UAC, zero PowerShell policy issues)
  const targets = [];
  if (desktop && fs.existsSync(dDir)) targets.push(path.join(dDir, 'Superpowers Studio.lnk'));
  if (startMenu && fs.existsSync(sDir)) targets.push(path.join(sDir, 'Superpowers Studio.lnk'));

  if (targets.length > 0) {
    const tmpScript = path.join(dataDir, `_create_shortcuts_${Date.now()}.vbs`);
    const lines = ['Set sh = CreateObject("WScript.Shell")'];
    for (const lnkPath of targets) {
      lines.push(`Set sc = sh.CreateShortcut("${escapeVbsString(lnkPath)}")`);
      lines.push('sc.TargetPath = "wscript.exe"');
      lines.push(`sc.Arguments = """${escapeVbsString(launcherPath)}"""`);
      lines.push(`sc.WorkingDirectory = "${escapeVbsString(REPO_ROOT)}"`);
      lines.push('sc.Description = "Launch and open Superpowers Studio"');
      lines.push(`sc.IconLocation = "${escapeVbsString(iconPath)},0"`);
      lines.push('sc.Save');
    }
    fs.writeFileSync(tmpScript, lines.join('\r\n'), 'utf8');
    try {
      execFileSyncImpl('cscript.exe', ['//NoLogo', tmpScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } finally {
      try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
    }
  }

  const status = getWindowsShortcutsStatus({ desktopDir: dDir, startMenuDir: sDir, platform });
  return { ...status, launcherPath, iconPath };
}

export function uninstallWindowsShortcuts({
  dataDir = DEFAULT_DATA_DIR,
  desktopDir,
  startMenuDir,
  platform = process.platform,
} = {}) {
  const defs = defaultShortcutDirs();
  const dDir = desktopDir || defs.desktopDir;
  const sDir = startMenuDir || defs.startMenuDir;
  for (const p of [
    path.join(dDir, 'Superpowers Studio.lnk'),
    path.join(sDir, 'Superpowers Studio.lnk'),
    path.join(dataDir, 'open-studio-hidden.vbs'),
  ]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  return getWindowsShortcutsStatus({ desktopDir: dDir, startMenuDir: sDir, platform });
}
