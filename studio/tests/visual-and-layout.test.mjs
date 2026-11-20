import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTempDir(prefix = 'sp-vis-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Visual Companion automatically inlines workspace PNG/SVG images, blocks traversal, and supports screen switching', async () => {
  const base = makeTempDir('sp-vis-inline-');
  const dataDir = path.join(base, 'data');
  const workDir = path.join(base, 'work');
  const secretPath = path.join(base, 'secret.png');
  fs.mkdirSync(path.join(workDir, 'outputs', 'charts'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'outputs', 'charts', 'preview.png'), TINY_PNG);
  fs.writeFileSync(path.join(workDir, 'assets', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
  fs.writeFileSync(secretPath, TINY_PNG);

  const studio = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${studio.port}`;

  try {
    const boot = await fetch(`${url}/?token=${studio.token}`);
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie, Origin: url, 'Content-Type': 'application/json' };

    const { session } = await (await fetch(`${url}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Visual Fix Test', workspacePath: workDir }),
    })).json();

    // Push two screens; screen 1 has relative PNG, SVG, and a traversal attempt
    studio.store.writeScreen(session.id, '01-first.html', `
      <div>
        <img id="png" src="outputs/charts/preview.png" alt="Preview">
        <img id="svg" src="./assets/diagram.svg" alt="Diagram">
        <img id="escape" src="../secret.png" alt="Escape">
      </div>
    `);
    await new Promise((r) => setTimeout(r, 20));
    studio.store.writeScreen(session.id, '02-second.html', '<h2>Second Screen</h2>');

    // Session detail lists both screens newest-first
    const detail = await (await fetch(`${url}/api/sessions/${session.id}`, { headers })).json();
    assert.ok(Array.isArray(detail.screens), 'detail.screens should be an array');
    assert.equal(detail.screens.length, 2);
    assert.equal(detail.screens[0].filename, '02-second.html');
    assert.equal(detail.screens[1].filename, '01-first.html');

    // Default companion serves latest screen
    const latestHtml = await (await fetch(`${url}/api/sessions/${session.id}/companion`, { headers: { Cookie: cookie } })).text();
    assert.match(latestHtml, /Second Screen/);

    // Explicit ?screen=01-first.html serves screen 1 with inlined data URIs and NO secret escape!
    const screen1Html = await (await fetch(`${url}/api/sessions/${session.id}/companion?screen=01-first.html`, { headers: { Cookie: cookie } })).text();
    assert.match(screen1Html, /id="png"\s+src="data:image\/png;base64,/);
    assert.match(screen1Html, /id="svg"\s+src="data:image\/svg\+xml;base64,/);
    assert.match(screen1Html, /id="escape"\s+src="\.\.\/secret\.png"/, 'Path traversal image MUST NOT be inlined');

    // Workspace images listing & safe file serving
    const imgsRes = await (await fetch(`${url}/api/sessions/${session.id}/workspace/images`, { headers })).json();
    assert.equal(imgsRes.images.length, 2);
    assert.ok(imgsRes.images.some((i) => i.path === 'outputs/charts/preview.png'));
    assert.ok(imgsRes.images.some((i) => i.path === 'assets/diagram.svg'));

    const pngRes = await fetch(`${url}/api/sessions/${session.id}/workspace/file?path=outputs/charts/preview.png`, { headers: { Cookie: cookie } });
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');

    const svgRes = await fetch(`${url}/api/sessions/${session.id}/workspace/file?path=assets/diagram.svg`, { headers: { Cookie: cookie } });
    assert.equal(svgRes.status, 200);
    assert.equal(svgRes.headers.get('content-type'), 'image/svg+xml');
    assert.match(svgRes.headers.get('content-security-policy') || '', /default-src 'none'/);

    const escRes = await fetch(`${url}/api/sessions/${session.id}/workspace/file?path=../secret.png`, { headers: { Cookie: cookie } });
    assert.ok(escRes.status === 400 || escRes.status === 403, `Expected 400/403 for traversal, got ${escRes.status}`);

    // Verify resizable handles, visual switcher, and session settings controls exist in index.html
    const indexHtml = await boot.text();
    assert.match(indexHtml, /id="resizer-left"/);
    assert.match(indexHtml, /id="resizer-right"/);
    assert.match(indexHtml, /id="companion-screen-select"/);
    assert.match(indexHtml, /id="btn-visual-mode-files"/);
    assert.match(indexHtml, /id="btn-session-settings"/);
    assert.match(indexHtml, /id="modal-session-settings"/);

    // Verify editing existing session provider/model settings via PUT /api/sessions/:id
    const upd = await (await fetch(`${url}/api/sessions/${session.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        title: 'Visual Fix Test (Edited)',
        providerId: 'anthropic',
        model: 'claude-sonnet-4-5',
        coordinatorProviderId: 'gemini',
        coordinatorModel: 'gemini-2.5-pro',
        expertProviderId: 'deepseek',
        expertModel: 'deepseek-reasoner',
        uninterruptedMode: true,
        maxTurns: 250,
      }),
    })).json();
    assert.equal(upd.session.title, 'Visual Fix Test (Edited)');
    assert.equal(upd.session.providerId, 'anthropic');
    assert.equal(upd.session.coordinatorProviderId, 'gemini');
    assert.equal(upd.session.expertProviderId, 'deepseek');
    assert.equal(upd.session.maxTurns, 250);
  } finally {
    await studio.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
