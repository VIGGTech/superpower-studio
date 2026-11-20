import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateQrMatrix, generateQrSvg } from '../lib/qr.mjs';
import { discoverMobileEndpoints, isRemoteOriginAllowed } from '../lib/network.mjs';
import { createStudioServer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = path.resolve(__dirname, '..', '..', 'skills');

function makeTempDir(prefix = 'sp-mob-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('zero-dependency QR generator produces valid finder patterns, sizing, and SVG for Studio URLs', () => {
  const sampleUrl = 'http://192.168.1.42:49500/?token=0123456789abcdef0123456789abcdef0123456789abcdef';
  const { size, modules, version } = generateQrMatrix(sampleUrl);
  assert.ok(version >= 5 && version <= 10, `Expected version 5..10 for 82-byte URL, got ${version}`);
  assert.equal(size, 17 + version * 4);
  assert.equal(modules.length, size);
  // Check top-left 7x7 finder pattern outer border & center 3x3
  for (let i = 0; i < 7; i++) {
    assert.equal(modules[0][i], 1);
    assert.equal(modules[6][i], 1);
    assert.equal(modules[i][0], 1);
    assert.equal(modules[i][6], 1);
  }
  assert.equal(modules[3][3], 1);
  // Check top-right & bottom-left finder centers
  assert.equal(modules[3][size - 4], 1);
  assert.equal(modules[size - 4][3], 1);

  const svg = generateQrSvg(sampleUrl);
  assert.match(svg, /^<svg[^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path /);
});

test('discoverMobileEndpoints classifies LAN vs Tailscale IPs and enforces strict remote Origin policy', () => {
  const fakeIfaces = {
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'Wi-Fi': [{ address: '192.168.1.55', family: 'IPv4', internal: false }],
    Tailscale: [{ address: '100.88.12.9', family: 'IPv4', internal: false }],
    'vEthernet (WSL)': [{ address: '172.24.0.1', family: 'IPv4', internal: false }],
  };
  const disc = discoverMobileEndpoints({
    port: 49500,
    token: 'tok1234567890abcdef',
    host: '0.0.0.0',
    interfaces: fakeIfaces,
  });
  assert.equal(disc.listeningAllInterfaces, true);
  assert.equal(disc.tailscale.length, 1);
  assert.equal(disc.tailscale[0].ip, '100.88.12.9');
  assert.equal(disc.lan[0].ip, '192.168.1.55', 'Real Wi-Fi adapter should rank ahead of virtual WSL adapter');

  // Strict origin allowlist checks
  const ctx = { port: 49500, allowRemote: true, interfaces: fakeIfaces, customOrigins: ['https://studio.example.com'] };
  assert.equal(isRemoteOriginAllowed('http://192.168.1.55:49500', ctx), true);
  assert.equal(isRemoteOriginAllowed('http://100.88.12.9:49500', ctx), true);
  assert.equal(isRemoteOriginAllowed('https://my-pc.tail99a.ts.net', ctx), true);
  assert.equal(isRemoteOriginAllowed('https://studio.example.com', ctx), true);
  assert.equal(isRemoteOriginAllowed('https://evil.example', ctx), false);
  assert.equal(isRemoteOriginAllowed('null', ctx), false);
  assert.equal(isRemoteOriginAllowed('http://192.168.1.55:9999', ctx), false, 'Wrong port must be rejected');

  // When remote access is OFF, LAN/Tailscale origins are rejected
  assert.equal(isRemoteOriginAllowed('http://192.168.1.55:49500', { ...ctx, allowRemote: false }), false);
});

test('HTTP /api/service and POST /api/service/mobile expose QR SVG, toggle remote access, and serve mobile UI', async () => {
  const dataDir = makeTempDir('sp-mobapi-');
  const studio = await createStudioServer({ dataDir, skillsRoot: SKILLS_ROOT, port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${studio.port}`;
  try {
    const boot = await fetch(`${base}/?token=${studio.token}`);
    const cookie = (boot.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };

    const indexHtml = await boot.text();
    assert.match(indexHtml, /id="mobile-nav"/);
    assert.match(indexHtml, /id="btn-toggle-mobile-access"/);
    assert.match(indexHtml, /id="mobile-qr-container"/);

    const svc1 = await (await fetch(`${base}/api/service`, { headers })).json();
    assert.equal(svc1.mobile.enabled, false);
    assert.ok(Array.isArray(svc1.mobile.endpoints));

    const upd = await (await fetch(`${base}/api/service/mobile`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true, customOrigins: ['https://my-studio.ts.net'] }),
    })).json();
    assert.equal(upd.mobile.enabled, true);
    assert.deepEqual(upd.mobile.customOrigins, ['https://my-studio.ts.net']);
    if (upd.mobile.primaryUrl) {
      assert.match(upd.mobile.qrSvg || '', /^<svg /);
    }

    // Verify custom origin is immediately honored on subsequent authenticated requests
    const origCheck = await fetch(`${base}/api/settings`, {
      headers: { Cookie: cookie, Origin: 'https://my-studio.ts.net' },
    });
    assert.equal(origCheck.status, 200);
  } finally {
    await studio.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
