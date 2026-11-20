import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stagePackageFiles, generateWixManifest, buildGettingStartedHtml } from '../packaging/build-msi.mjs';
import { installWindowsService, installWindowsShortcuts } from '../lib/daemon.mjs';
import { getVersionInfo } from '../lib/version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeTempDir(prefix = 'sp-pkg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('MSI packager stages bundled Node runtime, Studio, all 15 skills, Getting Started guide, and strictly excludes personal data/secrets', () => {
  const stageDir = makeTempDir('sp-stage-');
  try {
    const staged = stagePackageFiles({
      repoRoot: REPO_ROOT,
      stageDir,
      includeNodeRuntime: true,
      version: '1.0.0',
    });

    // 1. Bundled runtime + Studio core + all 15 skills present
    assert.equal(fs.existsSync(path.join(stageDir, 'runtime', 'node.exe')), true, 'Bundled node.exe must be staged');
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'server.mjs')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'daemon.mjs')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'public', 'index.html')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'skills', 'brainstorming', 'scripts', 'frame-template.html')), true);

    const skillDirs = fs.readdirSync(path.join(stageDir, 'app', 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(stageDir, 'app', 'skills', d.name, 'SKILL.md')));
    assert.equal(skillDirs.length, 15, 'All 15 Superpowers Core skills must be bundled');

    const engSkillDirs = fs.readdirSync(path.join(stageDir, 'app', 'studio', 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(stageDir, 'app', 'studio', 'skills', d.name, 'SKILL.md')));
    assert.equal(engSkillDirs.length, 8, 'All 8 Engineering Pack skills must be bundled');
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'skills', 'PACK.json')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'skills', 'security-and-hardening', 'references', 'security-checklist.md')), true);

    // 2. Launchers, icon, version metadata, MIT LICENSE, VIGGTech NOTICE, and Getting Started instructions
    const vInfo = getVersionInfo();
    assert.equal(vInfo.publisher, 'VIGGTech');
    assert.equal(vInfo.edition, 'VIGGTech Edition');
    assert.equal(vInfo.license, 'MIT');
    assert.equal(vInfo.repository, 'https://github.com/VIGGTech/superpower-studio');
    assert.equal(vInfo.upstream.url, 'https://github.com/obra/superpowers');
    assert.equal(vInfo.upstream.version, '7.0.2');

    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'version.json')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'LICENSE')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'NOTICE.txt')), true);
    const notice = fs.readFileSync(path.join(stageDir, 'app', 'NOTICE.txt'), 'utf8');
    assert.match(notice, /VIGGTech/);
    assert.match(notice, /https:\/\/github\.com\/obra\/superpowers/);
    assert.match(notice, /7\.0\.2/);
    assert.match(notice, /https:\/\/github\.com\/addyosmani\/agent-skills/);
    assert.match(notice, /Addy Osmani/);

    assert.equal(fs.existsSync(path.join(stageDir, 'assets', 'superpowers-studio.ico')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'launch-studio.vbs')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'stop-studio.vbs')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'post-install.vbs')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'GETTING-STARTED.html')), true);

    const guide = fs.readFileSync(path.join(stageDir, 'app', 'GETTING-STARTED.html'), 'utf8');
    assert.match(guide, /VIGGTech/i);
    assert.match(guide, /https:\/\/github\.com\/obra\/superpowers/);
    assert.match(guide, /API Keys/i);
    assert.match(guide, /Providers &amp; Models|Providers & Models/i);
    assert.match(guide, /Anthropic|Claude/i);
    assert.match(guide, /Gemini/i);
    assert.match(guide, /LOCALAPPDATA/i);

    const launcher = fs.readFileSync(path.join(stageDir, 'app', 'launch-studio.vbs'), 'utf8');
    assert.match(launcher, /SUPERPOWERS_STUDIO_DATA_DIR/);
    assert.match(launcher, /runtime\\node\.exe/);

    // 3. Strict privacy check — ZERO personal data, tests, or git history staged
    assert.equal(fs.existsSync(path.join(stageDir, 'app', '.superpowers-studio')), false);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'tests')), false);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', 'studio', 'packaging')), false);
    assert.equal(fs.existsSync(path.join(stageDir, 'app', '.git')), false);
    assert.ok(staged.files.length >= 40);

    // 4. WiX v5 manifest includes VIGGTech manufacturer, per-user install, shortcuts, Getting Started finish checkbox, and embedded CAB
    const wxs = generateWixManifest({ stageDir, version: '1.0.0' });
    assert.match(wxs, /http:\/\/wixtoolset\.org\/schemas\/v4\/wxs/);
    assert.match(wxs, /Manufacturer="VIGGTech"/);
    assert.match(wxs, /VIGGTech Edition/);
    assert.match(wxs, /Scope="perUser"/);
    assert.match(wxs, /EmbedCab="yes"/);
    assert.match(wxs, /WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT/);
    assert.match(wxs, /Launch Superpowers Studio/);
    assert.match(wxs, /Getting Started Guide/);
    assert.match(wxs, /DesktopFolder/);
    assert.match(wxs, /ProgramMenuFolder/);

    // 5. buildGettingStartedHtml returns complete standalone HTML
    const standaloneHtml = buildGettingStartedHtml({ version: '1.0.0' });
    assert.match(standaloneHtml, /<!DOCTYPE html>/i);
    assert.match(standaloneHtml, /Add Your API Keys/i);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

test('daemon Windows service & shortcut launchers preserve custom SUPERPOWERS_STUDIO_DATA_DIR for installed MSI mode', () => {
  const base = makeTempDir('sp-instdir-');
  const customDataDir = path.join(base, 'LocalAppData', 'SuperpowersStudio');
  const desktopDir = path.join(base, 'Desktop');
  const startMenuDir = path.join(base, 'StartMenu');
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(startMenuDir, { recursive: true });

  try {
    const noopExec = () => '';
    const svc = installWindowsService({
      dataDir: customDataDir,
      port: 49500,
      platform: 'win32',
      execFileSyncImpl: noopExec,
    });
    const svcVbs = fs.readFileSync(svc.launcherPath, 'utf8');
    assert.match(svcVbs, /SUPERPOWERS_STUDIO_DATA_DIR/);
    assert.ok(svcVbs.includes(customDataDir));

    const sc = installWindowsShortcuts({
      dataDir: customDataDir,
      port: 49500,
      desktop: true,
      startMenu: true,
      desktopDir,
      startMenuDir,
      platform: 'win32',
      execFileSyncImpl: noopExec,
    });
    const scVbs = fs.readFileSync(sc.launcherPath, 'utf8');
    assert.match(scVbs, /SUPERPOWERS_STUDIO_DATA_DIR/);
    assert.ok(scVbs.includes(customDataDir));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
