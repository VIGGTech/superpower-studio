import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStore } from './lib/store.mjs';
import { getDefaultSkillRoots, listSkillPacks, loadSkillCatalog, readSkill } from './lib/skills.mjs';
import { createWebSocketServer } from './lib/ws.mjs';
import { listProviderModels, testProviderConnection } from './lib/providers/index.mjs';
import { getWorkspaceStatus, cleanupSessionWorktree, assessWorkspacePurgeSafety, purgeWorkspaceDirectory } from './lib/worktree.mjs';
import { resolveScopedPath } from './lib/tools.mjs';
import { createOrchestrator, computeMissionEta } from './lib/orchestrator.mjs';
import {
  resolvePersistentToken,
  getDaemonStatus,
  getWindowsServiceStatus,
  installWindowsService,
  uninstallWindowsService,
  getWindowsShortcutsStatus,
  installWindowsShortcuts,
  uninstallWindowsShortcuts,
} from './lib/daemon.mjs';
import { discoverMobileEndpoints, isRemoteOriginAllowed } from './lib/network.mjs';
import { generateQrSvg } from './lib/qr.mjs';
import { getVersionInfo } from './lib/version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FRAME_TEMPLATE_PATH = path.join(REPO_ROOT, 'skills', 'brainstorming', 'scripts', 'frame-template.html');

const COOKIE_NAME = 'sp_studio_token';
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const WORKSPACE_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function inlineWorkspaceImagesInHtml(html, workDir) {
  if (!html || !workDir || !fs.existsSync(workDir)) return html;
  let workDirReal;
  try {
    workDirReal = fs.realpathSync(workDir);
  } catch {
    return html;
  }

  let totalBytes = 0;
  const MAX_SINGLE_BYTES = 6 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 28 * 1024 * 1024;
  const cache = new Map();

  const resolveImageDataUri = (rawRef) => {
    const trimmed = String(rawRef || '').trim();
    if (!trimmed) return null;
    if (/^(data:|https?:|blob:|mailto:|javascript:|#)/i.test(trimmed)) return null;
    const cleanRef = trimmed.split(/[?#]/)[0];
    let decoded = cleanRef;
    try { decoded = decodeURIComponent(cleanRef); } catch { /* keep raw */ }

    let candidate = decoded;
    if (/^file:\/\//i.test(candidate)) {
      try {
        const u = new URL(candidate);
        candidate = decodeURIComponent(u.pathname);
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(candidate)) {
          candidate = candidate.slice(1);
        }
      } catch {
        return null;
      }
    } else if (candidate.startsWith('/') && !path.isAbsolute(candidate)) {
      candidate = candidate.replace(/^\/+/, '');
    } else if (candidate.startsWith('/') && !fs.existsSync(candidate)) {
      // Treat leading slash like "/gallery/plate.png" as workspace-relative
      candidate = candidate.replace(/^\/+/, '');
    }

    const ext = path.extname(candidate).toLowerCase();
    const mime = WORKSPACE_IMAGE_MIME[ext];
    if (!mime) return null;

    if (cache.has(candidate)) return cache.get(candidate);

    let full;
    try {
      full = resolveScopedPath(workDirReal, candidate);
    } catch {
      cache.set(candidate, null);
      return null;
    }

    if (!fs.existsSync(full)) {
      cache.set(candidate, null);
      return null;
    }
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SINGLE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES) {
      cache.set(candidate, null);
      return null;
    }

    const buf = fs.readFileSync(full);
    totalBytes += buf.length;
    const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
    cache.set(candidate, dataUri);
    return dataUri;
  };

  return html.replace(
    /(<(?:img|object|image|source)\b[^>]*?\b(?:src|data|href|xlink:href)\s*=\s*)(["'])([^"']+)\2/gi,
    (match, prefix, quote, ref) => {
      const inlined = resolveImageDataUri(ref);
      if (!inlined) return match;
      return `${prefix}${quote}${inlined}${quote}`;
    }
  );
}

function listWorkspaceImages(workDir, { limit = 200 } = {}) {
  if (!workDir || !fs.existsSync(workDir)) return [];
  const SKIP = new Set(['.git', 'node_modules', '.superpowers-studio', '__pycache__', '.venv', 'venv', 'dist', '.cache']);
  const results = [];

  const walk = (dir, depth = 0) => {
    if (depth > 8 || results.length >= limit * 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        const mimeType = WORKSPACE_IMAGE_MIME[ext];
        if (!mimeType) continue;
        try {
          const st = fs.statSync(full);
          results.push({
            path: path.relative(workDir, full).replace(/\\/g, '/'),
            filename: ent.name,
            ext,
            mimeType,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch { /* ignore unreadable */ }
      }
    }
  };

  walk(workDir, 0);
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function buildCompanionHelperScript(sessionId) {
  const safeSid = JSON.stringify(sessionId);
  return `<script>
(function() {
  var SESSION_ID = ${safeSid};
  function sendEvent(ev) {
    try {
      window.parent.postMessage({ type: 'superpowers-companion-event', sessionId: SESSION_ID, event: ev }, '*');
    } catch (e) {}
  }
  window.toggleSelect = function(el) {
    var container = el.closest('.options, .cards');
    var multi = container && container.dataset.multiselect !== undefined;
    if (container && !multi) {
      container.querySelectorAll('.option, .card').forEach(function(o) { o.classList.remove('selected'); });
    }
    if (multi) el.classList.toggle('selected');
    else el.classList.add('selected');
    sendEvent({
      type: 'click',
      choice: el.dataset.choice || el.getAttribute('data-choice') || '',
      text: (el.innerText || '').trim().slice(0, 300),
      id: el.id || null,
      timestamp: Date.now()
    });
  };
  document.addEventListener('click', function(e) {
    var target = e.target.closest('[data-choice]');
    if (!target) return;
    if (target.getAttribute('onclick') && target.getAttribute('onclick').includes('toggleSelect')) return;
    window.toggleSelect(target);
  });
})();
</script>`;
}

function renderCompanionHtml(sessionId, latestScreen) {
  const helperScript = buildCompanionHelperScript(sessionId);
  const contentHtml = latestScreen
    ? latestScreen.html
    : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center;gap:10px">
         <h2 style="margin:0">Visual Companion Ready</h2>
         <p class="subtitle">Mockups, architecture diagrams, and anatomical illustrations pushed by Subordinate, Coordinator, or the Anatomical Illustrator will appear here automatically.</p>
       </div>`;

  if (/^\s*(<!doctype|<html)/i.test(contentHtml)) {
    if (/<\/body>/i.test(contentHtml)) {
      return contentHtml.replace(/<\/body>/i, () => `${helperScript}\n</body>`);
    }
    return `${contentHtml}\n${helperScript}`;
  }

  let template = '';
  if (fs.existsSync(FRAME_TEMPLATE_PATH)) {
    template = fs.readFileSync(FRAME_TEMPLATE_PATH, 'utf8');
  }
  if (template && template.includes('<!-- CONTENT -->')) {
    return template
      .replace(/<div class="header">[\s\S]*?<\/div>\s*<\/div>/i, '')
      .replace(/<header[\s\S]*?<\/header>/i, '')
      .replace(/<footer[\s\S]*?<\/footer>/i, '')
      .replace('<!-- CONTENT -->', () => contentHtml)
      .replace(/<\/body>/i, () => `${helperScript}\n</body>`);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 20px; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #1d1d1f; color: #f5f5f7; } }
  .options, .cards { display: grid; gap: 12px; margin-top: 16px; }
  .option, .card { border: 1px solid #8884; border-radius: 10px; padding: 14px; cursor: pointer; }
  .option.selected, .card.selected { border-color: #0071e3; background: rgba(0,113,227,0.12); }
</style>
</head>
<body>
${contentHtml}
${helperScript}
</body>
</html>`;
}

export async function createStudioServer({
  dataDir = process.env.SUPERPOWERS_STUDIO_DATA_DIR || path.join(REPO_ROOT, '.superpowers-studio'),
  skillsRoot = getDefaultSkillRoots(REPO_ROOT),
  port = 49500,
  host = '127.0.0.1',
  token,
  persistToken = process.env.SUPERPOWERS_STUDIO_PERSIST_TOKEN === '1',
  autoResume = false,
  streamChatImpl,
  windowsServiceController,
  windowsShortcutsController,
} = {}) {
  const effectiveToken = token
    || (persistToken ? resolvePersistentToken(dataDir, process.env.SUPERPOWERS_STUDIO_TOKEN || '') : (process.env.SUPERPOWERS_STUDIO_TOKEN || crypto.randomBytes(24).toString('hex')));

  const store = createStore({ dataDir });
  const reconciled = store.reconcileOnStartup();
  const svcCtrl = windowsServiceController || {
    status: () => getWindowsServiceStatus(),
    install: (opts) => installWindowsService(opts),
    uninstall: (opts) => uninstallWindowsService(opts),
  };
  const scCtrl = windowsShortcutsController || {
    status: () => getWindowsShortcutsStatus(),
    install: (opts) => installWindowsShortcuts(opts),
    uninstall: (opts) => uninstallWindowsShortcuts(opts),
  };

  const allowedOrigins = new Set();
  const wsServer = createWebSocketServer({
    validateUpgrade(req) {
      if (!isAuthenticated(req, new URL(req.url || '/', 'http://localhost'))) return false;
      const origin = req.headers.origin;
      if (origin !== undefined && !isAllowedOrigin(origin)) return false;
      return true;
    },
  });

  const orchestrator = createOrchestrator({
    store,
    skillsRoot,
    streamChatImpl,
    emitEvent: (ev) => wsServer.broadcast(ev),
  });

  function isAllowedOrigin(origin) {
    if (!origin || origin === 'null') return false;
    if (allowedOrigins.has(origin)) return true;
    const settings = store.getSettings();
    const allowRemote = host === '0.0.0.0' || host === '::' || Boolean(settings.remoteAccessEnabled);
    return isRemoteOriginAllowed(origin, {
      port: actualPort,
      allowRemote,
      customOrigins: settings.allowedOrigins || [],
    });
  }

  function buildMobileInfo() {
    const settings = store.getSettings();
    const enabled = Boolean(settings.remoteAccessEnabled) || host === '0.0.0.0' || host === '::';
    const disc = discoverMobileEndpoints({ port: actualPort, token: effectiveToken, host });
    const endpoints = disc.endpoints.map((ep) => {
      let qrSvg = '';
      try { qrSvg = generateQrSvg(ep.url); } catch { qrSvg = ''; }
      return { ...ep, qrSvg };
    });
    const primary = endpoints[0] || null;
    return {
      enabled,
      listeningAllInterfaces: disc.listeningAllInterfaces,
      needsRestartToBind: Boolean(settings.remoteAccessEnabled) && !disc.listeningAllInterfaces,
      endpoints,
      primaryUrl: primary?.url || null,
      qrSvg: primary?.qrSvg || '',
      customOrigins: settings.allowedOrigins || [],
      firewallCommand: `New-NetFirewallRule -DisplayName "Superpowers Studio" -Direction Inbound -Protocol TCP -LocalPort ${actualPort} -Action Allow -Profile Private`,
    };
  }

  function isAuthenticated(req, urlObj) {
    const qToken = urlObj.searchParams.get('token');
    if (qToken && timingSafeEqualStr(qToken, effectiveToken)) return true;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && timingSafeEqualStr(auth.slice(7).trim(), effectiveToken)) return true;
    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies[COOKIE_NAME] && timingSafeEqualStr(cookies[COOKIE_NAME], effectiveToken)) return true;
    return false;
  }

  function checkMutationOrigin(req) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      return isAllowedOrigin(origin);
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = urlObj.pathname;
    const method = req.method || 'GET';

    // Lightweight unauthenticated liveness check for daemon supervisor
    if (method === 'GET' && pathname === '/api/health') {
      const v = getVersionInfo();
      return sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        detached: process.env.SUPERPOWERS_STUDIO_DETACHED === '1',
        version: v.version,
        edition: v.edition,
        publisher: v.publisher,
        upstreamVersion: v.upstream.version,
      });
    }

    // Handle initial token bootstrap on GET /
    if (method === 'GET' && pathname === '/') {
      const qToken = urlObj.searchParams.get('token');
      if (qToken && timingSafeEqualStr(qToken, effectiveToken)) {
        const cookie = `${COOKIE_NAME}=${encodeURIComponent(effectiveToken)}; HttpOnly; SameSite=Strict; Path=/`;
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        const html = fs.existsSync(indexPath)
          ? fs.readFileSync(indexPath, 'utf8')
          : '<!DOCTYPE html><html><body><h1>Superpowers Studio</h1></body></html>';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': cookie,
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(html);
        return;
      }
      if (!isAuthenticated(req, urlObj)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>403 Forbidden</h1><p>Open Superpowers Studio using the full startup URL including <code>?token=...</code>.</p>');
        return;
      }
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      const html = fs.existsSync(indexPath)
        ? fs.readFileSync(indexPath, 'utf8')
        : '<!DOCTYPE html><html><body><h1>Superpowers Studio</h1></body></html>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(html);
      return;
    }

    // Static assets (CSS / JS)
    if (method === 'GET' && !pathname.startsWith('/api/')) {
      if (!isAuthenticated(req, urlObj)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const rel = pathname.replace(/^\/+/, '');
      const full = path.resolve(PUBLIC_DIR, rel);
      const relToPublic = path.relative(PUBLIC_DIR, full);
      const inside = !relToPublic.startsWith('..') && !path.isAbsolute(relToPublic);
      if (inside && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(fs.readFileSync(full));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // All /api/* routes require authentication + strict Origin validation
    if (!isAuthenticated(req, urlObj)) {
      return sendJson(res, 403, { error: 'Authentication required' });
    }
    if (method !== 'GET' && !checkMutationOrigin(req)) {
      return sendJson(res, 403, { error: 'Forbidden Origin' });
    }
    if (req.headers.origin !== undefined && !isAllowedOrigin(req.headers.origin)) {
      return sendJson(res, 403, { error: 'Forbidden Origin' });
    }

    try {
      // ----- Providers -----
      if (pathname === '/api/providers' && method === 'GET') {
        return sendJson(res, 200, { providers: store.getProvidersMasked() });
      }
      if (pathname === '/api/providers' && method === 'POST') {
        const body = await readJsonBody(req);
        const saved = store.upsertProvider(body);
        return sendJson(res, 201, { provider: store.getProvidersMasked().find((p) => p.id === saved.id) });
      }
      let m = pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const existing = store.getProvider(id);
          const payload = { ...(existing || {}), ...body, id };
          if (body.apiKey === undefined) delete payload.apiKey;
          store.upsertProvider(payload);
          return sendJson(res, 200, { provider: store.getProvidersMasked().find((p) => p.id === id) });
        }
        if (method === 'DELETE') {
          const ok = store.deleteProvider(id);
          return sendJson(res, ok ? 200 : 404, { deleted: ok });
        }
      }
      m = pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
      if (m && (method === 'GET' || method === 'POST')) {
        const id = decodeURIComponent(m[1]);
        const saved = store.getProvider(id);
        const override = method === 'POST' ? await readJsonBody(req) : {};
        if (!saved && !override.baseUrl) return sendJson(res, 404, { error: 'Provider not found' });
        const effective = {
          ...(saved || { id, name: override.name || id, kind: override.kind || 'openai-compatible', extraHeaders: {} }),
          ...override,
          effectiveApiKey: override.apiKey || saved?.effectiveApiKey || (override.envVar ? process.env[override.envVar] : '') || '',
        };
        const models = await listProviderModels(effective);
        if (saved && models.length > 0) {
          store.upsertProvider({ id: saved.id, name: saved.name, kind: saved.kind, models });
        }
        return sendJson(res, 200, { models });
      }
      m = pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const saved = store.getProvider(id);
        const body = await readJsonBody(req);
        if (!saved && !body.baseUrl) return sendJson(res, 404, { error: 'Provider not found' });
        const effective = {
          ...(saved || { id, name: body.name || id, kind: body.kind || 'openai-compatible', extraHeaders: {} }),
          ...body,
          effectiveApiKey: body.apiKey || saved?.effectiveApiKey || (body.envVar ? process.env[body.envVar] : '') || '',
        };
        const result = await testProviderConnection(effective, body.model || effective.defaultModel);
        return sendJson(res, 200, result);
      }

      // ----- Expert Roster -----
      if (pathname === '/api/experts' && method === 'GET') {
        return sendJson(res, 200, { experts: store.getExpertRoster() });
      }
      if (pathname === '/api/experts' && method === 'POST') {
        const body = await readJsonBody(req);
        const saved = store.upsertExpertProfile(body);
        return sendJson(res, 201, { expert: saved });
      }
      m = pathname.match(/^\/api\/experts\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const saved = store.upsertExpertProfile({ ...body, id });
          return sendJson(res, 200, { expert: saved });
        }
        if (method === 'DELETE') {
          const ok = store.deleteExpertProfile(id);
          return sendJson(res, ok ? 200 : 404, { deleted: ok });
        }
      }

      // ----- Skills -----
      if (pathname === '/api/skills' && method === 'GET') {
        const skills = loadSkillCatalog(skillsRoot).map(({ name, description, files, pack, packLabel, source }) => ({
          name,
          description,
          files,
          pack,
          packLabel,
          source,
        }));
        const packs = listSkillPacks(skillsRoot);
        return sendJson(res, 200, { skills, packs });
      }
      m = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (m && method === 'GET') {
        const name = decodeURIComponent(m[1]);
        const file = urlObj.searchParams.get('file') || 'SKILL.md';
        const loaded = readSkill(skillsRoot, name, file);
        if (!loaded) return sendJson(res, 404, { error: 'Skill not found' });
        return sendJson(res, 200, loaded);
      }

      // ----- Settings & Background Service -----
      if (pathname === '/api/settings' && method === 'GET') {
        return sendJson(res, 200, {
          settings: store.getSettings(),
          defaultWorkspace: REPO_ROOT,
          versionInfo: getVersionInfo(),
        });
      }
      if (pathname === '/api/settings' && method === 'PUT') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { settings: store.updateSettings(body) });
      }
      if (pathname === '/api/service' && method === 'GET') {
        const daemon = await getDaemonStatus({ dataDir });
        const windowsService = svcCtrl.status();
        const windowsShortcuts = scCtrl.status();
        const settings = store.getSettings();
        return sendJson(res, 200, {
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          detached: process.env.SUPERPOWERS_STUDIO_DETACHED === '1',
          host,
          port: actualPort,
          url,
          dataDir,
          daemon,
          windowsService,
          windowsShortcuts,
          mobile: buildMobileInfo(),
          versionInfo: getVersionInfo(),
          autoResumeOnRestart: settings.autoResumeOnRestart !== false,
        });
      }
      if (pathname === '/api/service/mobile' && method === 'POST') {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.enabled !== undefined) patch.remoteAccessEnabled = Boolean(body.enabled);
        if (Array.isArray(body.customOrigins)) {
          patch.allowedOrigins = body.customOrigins
            .map((o) => String(o || '').trim().replace(/\/+$/, ''))
            .filter((o) => /^https?:\/\/[^/\s]+$/i.test(o));
        }
        store.updateSettings(patch);
        return sendJson(res, 200, { mobile: buildMobileInfo() });
      }
      if (pathname === '/api/service/windows' && method === 'POST') {
        const body = await readJsonBody(req);
        const enabled = Boolean(body.enabled);
        const result = enabled
          ? svcCtrl.install({ dataDir, port: actualPort, host })
          : svcCtrl.uninstall({ dataDir });
        store.updateSettings({ windowsServiceEnabled: Boolean(result.installed) });
        return sendJson(res, 200, { windowsService: result });
      }
      if (pathname === '/api/service/shortcuts' && method === 'POST') {
        const body = await readJsonBody(req);
        const enabled = Boolean(body.enabled);
        const result = enabled
          ? scCtrl.install({
              dataDir,
              port: actualPort,
              host,
              desktop: body.desktop !== false,
              startMenu: body.startMenu !== false,
            })
          : scCtrl.uninstall({ dataDir });
        return sendJson(res, 200, { windowsShortcuts: result });
      }

      // ----- Sessions -----
      if (pathname === '/api/sessions' && method === 'GET') {
        const sessions = store.listSessions().map((s) => {
          const eta = computeMissionEta(s.tasks || []);
          const elapsedSeconds = s.startedAt
            ? Math.max(0, Math.round((Date.now() - Date.parse(s.startedAt)) / 1000))
            : 0;
          return { ...s, missionSummary: { ...eta, elapsedSeconds } };
        });
        return sendJson(res, 200, { sessions });
      }
      if (pathname === '/api/sessions' && method === 'POST') {
        const body = await readJsonBody(req);
        const session = store.createSession(body);
        wsServer.broadcast({ type: 'session_updated', sessionId: session.id, session });
        return sendJson(res, 201, { session });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'GET') {
          const session = store.getSession(id);
          if (!session) return sendJson(res, 404, { error: 'Session not found' });
          const eta = computeMissionEta(session.tasks || []);
          const elapsedSeconds = session.startedAt
            ? Math.max(0, Math.round((Date.now() - Date.parse(session.startedAt)) / 1000))
            : 0;
          return sendJson(res, 200, {
            session: { ...session, missionSummary: { ...eta, elapsedSeconds } },
            messages: store.getMessages(id),
            coordinator: store.getCoordinator(id),
            experts: store.listExperts(id),
            attachments: store.listAttachments(id),
            latestScreen: store.getLatestScreen(id)?.filename || null,
            screens: store.listScreens(id),
            companionEvents: store.getCompanionEvents(id, 20),
            purgeInfo: assessWorkspacePurgeSafety({
              session,
              allSessions: store.listSessions(),
              repoRoot: REPO_ROOT,
              dataDir,
            }),
          });
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const allowed = {};
          for (const k of [
            'title', 'providerId', 'model',
            'coordinatorProviderId', 'coordinatorModel',
            'expertProviderId', 'expertModel',
            'rules', 'plan', 'maxTurns', 'uninterruptedMode',
          ]) {
            if (body[k] !== undefined) allowed[k] = body[k];
          }
          const updated = store.updateSession(id, allowed);
          wsServer.broadcast({ type: 'session_updated', sessionId: id, session: updated });
          return sendJson(res, 200, { session: updated });
        }
        if (method === 'DELETE') {
          const session = store.getSession(id);
          if (!session) return sendJson(res, 404, { error: 'Session not found' });
          const purge = urlObj.searchParams.get('purge') === 'true';
          const force = purge || urlObj.searchParams.get('force') === 'true';
          const deleteBranch = purge || urlObj.searchParams.get('deleteBranch') === 'true';
          const deleteWorkspace = urlObj.searchParams.get('deleteWorkspace') === 'true';

          if (session.worktreeBranch && !force) {
            const st = await getWorkspaceStatus(session.effectiveWorkDir || session.workspacePath);
            if (st.changedFiles.length > 0) {
              return sendJson(res, 409, {
                error: 'Worktree has uncommitted changes. Pass ?force=true to remove worktree (branch is preserved).',
                dirtyFiles: st.changedFiles.map((f) => `${f.status} ${f.path}`),
                worktreeBranch: session.worktreeBranch,
              });
            }
          }
          await orchestrator.stopSession(id);
          const wt = await cleanupSessionWorktree({ session, dataDir, force, deleteBranch });
          if (session.worktreeBranch && !wt.removed && wt.dirtyFiles?.length) {
            return sendJson(res, 409, {
              error: 'Worktree has uncommitted changes. Pass ?force=true to remove worktree (branch is preserved).',
              dirtyFiles: wt.dirtyFiles,
              worktreeBranch: session.worktreeBranch,
            });
          }

          let workspaceDeleted = false;
          let workspaceBlockedReason = null;
          const warnings = [];
          if (wt.warning) warnings.push(wt.warning);
          if (deleteWorkspace) {
            const wsRes = purgeWorkspaceDirectory({
              session,
              allSessions: store.listSessions(),
              repoRoot: REPO_ROOT,
              dataDir,
            });
            workspaceDeleted = Boolean(wsRes.deleted);
            if (wsRes.blocked) workspaceBlockedReason = wsRes.reason;
            else if (!wsRes.deleted && wsRes.reason && wsRes.reason !== 'Directory already absent.') {
              warnings.push(wsRes.reason);
            }
          }

          store.deleteSession(id);
          wsServer.broadcast({ type: 'session_deleted', sessionId: id });
          return sendJson(res, 200, {
            deleted: true,
            worktreeRemoved: Boolean(wt.removed),
            branchDeleted: Boolean(wt.branchDeleted),
            worktreeBranch: session.worktreeBranch,
            workspaceDeleted,
            workspaceBlockedReason,
            warnings,
          });
        }
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/skills$/);
      if (m && method === 'PUT') {
        const id = decodeURIComponent(m[1]);
        const body = await readJsonBody(req);
        const session = orchestrator.setPinnedSkills(id, body.pinnedSkills || []);
        return sendJson(res, 200, { session });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/attachments$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        if (!store.getSession(id)) return sendJson(res, 404, { error: 'Session not found' });
        const body = await readJsonBody(req);
        const attachment = store.saveAttachment(id, body);
        return sendJson(res, 201, { attachment });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const attId = decodeURIComponent(m[2]);
        const att = store.getAttachment(id, attId);
        if (!att) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const headers = {
          'Content-Type': att.mimeType,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        };
        if (att.mimeType === 'image/svg+xml') {
          headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
        }
        res.writeHead(200, headers);
        res.end(att.buffer);
        return;
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const body = await readJsonBody(req);
        const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
        if ((!body.content || !String(body.content).trim()) && !hasAttachments) {
          return sendJson(res, 400, { error: 'content or attachments is required' });
        }
        const session = await orchestrator.sendUserMessage(id, String(body.content || ''), body.attachments || []);
        return sendJson(res, 200, { session, messages: store.getMessages(id) });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/approve$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const body = await readJsonBody(req);
        try {
          const session = await orchestrator.approveAndRun(id, {
            rules: body.rules,
            plan: body.plan,
            allowSharedNonGit: Boolean(body.allowSharedNonGit),
          });
          return sendJson(res, 200, { session });
        } catch (err) {
          if (err.code === 'WORKSPACE_CONFLICT') {
            return sendJson(res, 409, { error: err.message, code: 'WORKSPACE_CONFLICT' });
          }
          throw err;
        }
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/relay$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const body = await readJsonBody(req);
        if (!body.instructions || !String(body.instructions).trim()) {
          return sendJson(res, 400, { error: 'instructions is required' });
        }
        const session = await orchestrator.relayDirect(id, String(body.instructions), body.priority || 'normal');
        return sendJson(res, 200, { session });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/reopen-interview$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const session = await orchestrator.reopenInterview(id);
        return sendJson(res, 200, { session });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/pause$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const session = await orchestrator.pauseSession(id);
        return sendJson(res, 200, { session });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const session = await orchestrator.resumeSession(id);
        return sendJson(res, 200, { session });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const session = await orchestrator.stopSession(id);
        return sendJson(res, 200, { session });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/coordinator$/);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        if (!store.getSession(id)) return sendJson(res, 404, { error: 'Session not found' });
        return sendJson(res, 200, {
          coordinator: store.getCoordinator(id),
          experts: store.listExperts(id),
        });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/experts\/([^/]+)$/);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const expId = decodeURIComponent(m[2]);
        const expert = store.getExpert(id, expId);
        if (!expert) return sendJson(res, 404, { error: 'Expert not found' });
        return sendJson(res, 200, { expert });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/workspace\/status$/);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const session = store.getSession(id);
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        const status = await getWorkspaceStatus(session.effectiveWorkDir || session.workspacePath);
        return sendJson(res, 200, {
          workspacePath: session.workspacePath,
          effectiveWorkDir: session.effectiveWorkDir,
          worktreeBranch: session.worktreeBranch,
          ...status,
        });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/workspace\/images$/);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const session = store.getSession(id);
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        const workDir = session.effectiveWorkDir || session.workspacePath;
        return sendJson(res, 200, { images: listWorkspaceImages(workDir, { limit: 200 }) });
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/workspace\/file$/);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const session = store.getSession(id);
        if (!session) return sendJson(res, 404, { error: 'Session not found' });
        const relPath = urlObj.searchParams.get('path') || '';
        const workDir = session.effectiveWorkDir || session.workspacePath;
        if (!relPath || !workDir || !fs.existsSync(workDir)) {
          return sendJson(res, 400, { error: 'Invalid workspace file path' });
        }
        const ext = path.extname(relPath).toLowerCase();
        const mimeType = WORKSPACE_IMAGE_MIME[ext];
        if (!mimeType) {
          return sendJson(res, 403, { error: 'Only image files (.png, .svg, .jpg, .webp, .gif) can be previewed here' });
        }
        let full;
        try {
          full = resolveScopedPath(fs.realpathSync(workDir), relPath);
        } catch (err) {
          return sendJson(res, 403, { error: err.message });
        }
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
          return sendJson(res, 404, { error: 'Workspace image not found' });
        }
        const buf = fs.readFileSync(full);
        const extra = mimeType === 'image/svg+xml'
          ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
          : {};
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...extra,
        });
        res.end(buf);
        return;
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/companion$/);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const session = store.getSession(id);
        if (!session) {
          res.writeHead(404);
          res.end('Session not found');
          return;
        }
        const requestedScreen = urlObj.searchParams.get('screen');
        const screen = requestedScreen ? store.getScreen(id, requestedScreen) : store.getLatestScreen(id);
        const rawHtml = renderCompanionHtml(id, screen);
        const html = inlineWorkspaceImagesInHtml(rawHtml, session.effectiveWorkDir || session.workspacePath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "frame-ancestors 'self'",
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(html);
        return;
      }

      m = pathname.match(/^\/api\/sessions\/([^/]+)\/companion\/events$/);
      if (m && method === 'POST') {
        const id = decodeURIComponent(m[1]);
        if (!store.getSession(id)) return sendJson(res, 404, { error: 'Session not found' });
        const body = await readJsonBody(req);
        const saved = store.appendCompanionEvent(id, body);
        wsServer.broadcast({ type: 'companion_event', sessionId: id, event: saved });
        return sendJson(res, 200, { ok: true, event: saved });
      }

      return sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || 'Internal server error' });
    }
  });

  wsServer.attach(server, '/ws');

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const actualPort = addr.port;
  allowedOrigins.add(`http://${host}:${actualPort}`);
  allowedOrigins.add(`http://localhost:${actualPort}`);
  allowedOrigins.add(`http://127.0.0.1:${actualPort}`);

  const displayHost = (host === '127.0.0.1' || host === '0.0.0.0' || host === '::') ? 'localhost' : host;
  const url = `http://${displayHost}:${actualPort}/?token=${effectiveToken}`;

  const autoResumedSessions = [];
  if (autoResume && store.getSettings().autoResumeOnRestart !== false) {
    for (const sid of reconciled.autoResumableSessions || []) {
      try {
        store.appendMessage(sid, {
          role: 'system',
          content: 'Studio restarted — auto-resuming uninterrupted Coordinator execution.',
        });
        await orchestrator.resumeSession(sid);
        autoResumedSessions.push(sid);
      } catch (err) {
        store.appendMessage(sid, {
          role: 'system',
          content: `Auto-resume after restart failed (${err.message}). Click Resume to continue.`,
        });
      }
    }
  }

  return {
    server,
    port: actualPort,
    host,
    token: effectiveToken,
    url,
    store,
    orchestrator,
    autoResumedSessions,
    async close() {
      wsServer.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// CLI entrypoint
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  let port = Number(process.env.SUPERPOWERS_STUDIO_PORT) || 49500;
  let host = process.env.SUPERPOWERS_STUDIO_HOST || '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === '--host' && args[i + 1]) host = args[++i];
  }
  if (!host) {
    const cliDataDir = process.env.SUPERPOWERS_STUDIO_DATA_DIR || path.join(REPO_ROOT, '.superpowers-studio');
    try {
      const sPath = path.join(cliDataDir, 'settings.json');
      const sRaw = fs.existsSync(sPath) ? JSON.parse(fs.readFileSync(sPath, 'utf8')) : {};
      host = sRaw?.remoteAccessEnabled ? '0.0.0.0' : '127.0.0.1';
    } catch {
      host = '127.0.0.1';
    }
  }
  createStudioServer({ port, host, persistToken: true, autoResume: true })
    .then((studio) => {
      console.log(JSON.stringify({
        type: 'studio-started',
        port: studio.port,
        host: studio.host,
        url: studio.url,
        dataDir: studio.store.dataDir,
      }));
    })
    .catch((err) => {
      console.error('Failed to start Superpowers Studio:', err.message);
      process.exit(1);
    });
}
