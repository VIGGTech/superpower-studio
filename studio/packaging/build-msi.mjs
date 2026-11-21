#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildStudioIcoBuffer } from '../lib/daemon.mjs';
import { getVersionInfo } from '../lib/version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
export const DEFAULT_VERSION = getVersionInfo().version;
export const UPGRADE_CODE = '7A5C3B92-4E81-4D2B-A9F1-6C83E4F1209B';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function copyTreeFiltered(srcDir, dstDir, { skipNames = new Set() } = {}) {
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyTreeFiltered(src, dst, { skipNames });
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

export function buildGettingStartedHtml({ version = DEFAULT_VERSION, versionInfo = getVersionInfo() } = {}) {
  const publisher = versionInfo.publisher || 'VIGGTech';
  const edition = versionInfo.edition || 'VIGGTech Edition';
  const upstreamUrl = versionInfo.upstream?.url || 'https://github.com/obra/superpowers';
  const upstreamVer = versionInfo.upstream?.version || '7.0.2';
  const upstreamAuthor = versionInfo.upstream?.author || 'Jesse Vincent';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Superpowers Studio (${escapeXml(edition)}) v${escapeXml(version)} — Getting Started</title>
  <style>
    :root { --bg: #f5f5f7; --card: #ffffff; --border: #d8dce3; --text: #1c1e22; --muted: #5a6270; --accent: #0071e3; --ok: #1f8b4c; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #111318; --card: #1b1f27; --border: #2f3644; --text: #edf0f5; --muted: #98a2b3; --accent: #3b9eff; --ok: #34c759; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.55; }
    .wrap { max-width: 780px; margin: 0 auto; padding: 32px 20px 56px; }
    .hero { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 26px 28px; margin-bottom: 18px; }
    .badge { display: inline-block; background: rgba(31,139,76,0.14); color: var(--ok); font-weight: 700; font-size: 12px; padding: 3px 10px; border-radius: 999px; margin-bottom: 10px; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    .sub { margin: 0; color: var(--muted); font-size: 15px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; margin-bottom: 14px; }
    .step-title { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; font-size: 17px; }
    .num { width: 26px; height: 26px; border-radius: 50%; background: var(--accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
    ul { margin: 8px 0 0; padding-left: 20px; }
    li { margin: 5px 0; }
    code { background: rgba(127,127,127,0.14); padding: 2px 6px; border-radius: 5px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
    .providers { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .pill { border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--muted); }
    .tip { border-left: 3px solid var(--accent); padding: 8px 12px; background: rgba(0,113,227,0.08); border-radius: 6px; margin-top: 12px; font-size: 13px; }
    .footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 22px; }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <span class="badge">&#10003; Installed Successfully &middot; ${escapeXml(publisher)} v${escapeXml(version)} (Open Source &middot; MIT)</span>
      <h1>Welcome to Superpowers Studio &mdash; ${escapeXml(edition)}</h1>
      <p class="sub">Your multi-provider 3-tier autonomous agent environment (<strong>Subordinate &rarr; Coordinator &rarr; Specialist Experts</strong>) is ready to use &mdash; Node.js is bundled, so zero extra setup is required.</p>
    </div>

    <div class="card">
      <h2 class="step-title"><span class="num">1</span> Add Your API Keys</h2>
      <p>Superpowers Studio runs 100% locally on your PC and connects directly to your chosen AI model provider(s):</p>
      <ul>
        <li>Open <strong>Superpowers Studio</strong> from your <strong>Desktop icon</strong> or <strong>Start Menu</strong> (it launches automatically in your browser).</li>
        <li>Click <strong>1. Configure API Keys</strong> (or <strong>Providers &amp; Models</strong> in the bottom-left sidebar).</li>
        <li>Select a provider, paste your API key, click <strong>Test</strong> to verify, and click <strong>Save Provider</strong>.</li>
        <li>You can mix and match providers per tier (for example, Claude for Subordinate, Gemini or DeepSeek for Coordinator, or local Ollama with zero API key!).</li>
      </ul>
      <div class="providers">
        <span class="pill">Anthropic (Claude)</span>
        <span class="pill">Google Gemini</span>
        <span class="pill">DeepSeek</span>
        <span class="pill">Alibaba Qwen</span>
        <span class="pill">Abliteration.ai</span>
        <span class="pill">OpenRouter (Free &amp; Open-Weight)</span>
        <span class="pill">Groq (Free Tier)</span>
        <span class="pill">Cerebras</span>
        <span class="pill">Ollama (Local)</span>
        <span class="pill">+ Any Custom OpenAI-Compatible API</span>
      </div>
      <div class="tip"><strong>Privacy:</strong> Your API keys, sessions, and auth token are saved locally under <code>%LOCALAPPDATA%\\SuperpowersStudio</code> and are never shared with anyone.</div>
    </div>

    <div class="card">
      <h2 class="step-title"><span class="num">2</span> Start Your First Session</h2>
      <ul>
        <li>Click <strong>+ New Session</strong> in the top-left sidebar.</li>
        <li>Give your project a title and choose a workspace folder (Studio creates it automatically if it doesn't exist yet).</li>
        <li>Choose your models for <strong>Subordinate</strong>, <strong>Coordinator</strong>, and <strong>Experts</strong> (you can change them anytime later via the <strong>Settings</strong> button!).</li>
      </ul>
    </div>

    <div class="card">
      <h2 class="step-title"><span class="num">3</span> Interview, Lock Rules &amp; Dispatch</h2>
      <ul>
        <li>Chat with the <strong>Subordinate</strong> (paste reference screenshots with <code>Ctrl+V</code> or click <strong>+ Image</strong>).</li>
        <li>Once you agree on the rules and plan, click <strong>Approve &amp; Dispatch</strong>.</li>
        <li>The <strong>Coordinator</strong> and specialist <strong>Experts</strong> run autonomously in the background until 100% of tasks are complete (even if you close your browser tab!).</li>
        <li>Inspect live outputs in the <strong>Agents</strong> and <strong>Visual</strong> tabs (drag the vertical dividers to resize sidebars).</li>
      </ul>
    </div>

    <div class="card">
      <h2 class="step-title"><span class="num">4</span> Optional: Windows Auto-Start &amp; Mobile Phone Access</h2>
      <ul>
        <li>Click <strong>Background &amp; Service</strong> in the bottom-left sidebar to:
          <ul>
            <li>Enable <strong>Windows Auto-Start at Logon</strong> so Studio starts silently after a PC reboot and auto-resumes uninterrupted sessions.</li>
            <li>Enable <strong>Mobile Access (Wi-Fi LAN + Tailscale VPN)</strong> and scan the local <strong>QR code</strong> from your phone camera to monitor and steer sessions from anywhere.</li>
          </ul>
        </li>
        <li>To stop Studio cleanly anytime, use <strong>Stop Superpowers Studio</strong> in your Start Menu.</li>
      </ul>
    </div>

    <div class="footer">
      <strong>Superpowers Studio &mdash; ${escapeXml(edition)} v${escapeXml(version)}</strong> (Open Source &middot; MIT License) &middot; <a href="${escapeXml(versionInfo.repository || 'https://github.com/VIGGTech/superpower-studio')}" target="_blank" rel="noopener noreferrer">GitHub Repository</a><br>
      Derived from <a href="${escapeXml(upstreamUrl)}" target="_blank" rel="noopener noreferrer">${escapeXml(upstreamUrl)}</a> v${escapeXml(upstreamVer)} (Copyright &copy; 2025 ${escapeXml(upstreamAuthor)}, MIT License) &middot; Engineering Pack skills &amp; auditor personas adapted from <a href="https://github.com/addyosmani/agent-skills" target="_blank" rel="noopener noreferrer">addyosmani/agent-skills</a> (Copyright &copy; 2025 Addy Osmani, MIT License)<br>
      Data stored in <code>%LOCALAPPDATA%\\SuperpowersStudio</code> &middot; Uninstall anytime via Windows Settings &rarr; Installed Apps
    </div>
  </div>
</body>
</html>
`;
}

function buildLicenseRtf({ version = DEFAULT_VERSION, versionInfo = getVersionInfo() } = {}) {
  const edition = versionInfo.edition || 'VIGGTech Edition';
  const upstreamUrl = versionInfo.upstream?.url || 'https://github.com/obra/superpowers';
  const upstreamVer = versionInfo.upstream?.version || '7.0.2';
  const upstreamAuthor = versionInfo.upstream?.author || 'Jesse Vincent';
  return [
    '{\\rtf1\\ansi\\deff0',
    '{\\fonttbl{\\f0 Segoe UI;}}',
    `\\fs20\\b Superpowers Studio (${edition} v${version}) — Open Source (MIT License)\\b0\\par\\par`,
    `This VIGGTech open-source edition of Superpowers Studio is derived from obra/superpowers v${upstreamVer} (${upstreamUrl}), Copyright (c) 2025 ${upstreamAuthor}, licensed under the MIT License. Engineering Pack skills and Quality/Security auditor personas are adapted from addyosmani/agent-skills (https://github.com/addyosmani/agent-skills), Copyright (c) 2025 Addy Osmani, licensed under the MIT License.\\par\\par`,
    '\\b What gets installed:\\b0\\par',
    '- Superpowers Studio (VIGGTech Edition) + bundled Node.js v20 runtime in %LOCALAPPDATA%\\Programs\\SuperpowersStudio (no admin rights required)\\par',
    '- All 15 Superpowers Core workflow skills + 8 Engineering Pack skills (23 live skills) + 12 Specialist Experts + full MIT LICENSE & NOTICE attribution\\par',
    '- Desktop & Start Menu shortcuts + Getting Started Guide\\par\\par',
    '\\b After installation:\\b0\\par',
    '1. Open Superpowers Studio and click "1. Configure API Keys" (or "Providers & Models") to add your own API keys (Anthropic, Gemini, DeepSeek, Qwen, OpenRouter, Groq, Cerebras, Abliteration.ai, or local Ollama).\\par',
    '2. Your API keys and sessions stay 100% local in %LOCALAPPDATA%\\SuperpowersStudio.\\par',
    '}',
  ].join('\r\n');
}

function buildNoticeTxt({ version = DEFAULT_VERSION, versionInfo = getVersionInfo() } = {}) {
  const upstreamUrl = versionInfo.upstream?.url || 'https://github.com/obra/superpowers';
  const upstreamVer = versionInfo.upstream?.version || '7.0.2';
  const upstreamAuthor = versionInfo.upstream?.author || 'Jesse Vincent';
  return [
    `Superpowers Studio — ${versionInfo.edition || 'VIGGTech Edition'} v${version}`,
    `Publisher: ${versionInfo.publisher || 'VIGGTech'}`,
    `License: ${versionInfo.license || 'MIT'} (Open Source)`,
    `Repository: ${versionInfo.repository || 'https://github.com/VIGGTech/superpower-studio'}`,
    '',
    'Upstream Attribution:',
    `Derived from obra/superpowers v${upstreamVer}`,
    `Repository: ${upstreamUrl}`,
    `Original Author: Copyright (c) 2025 ${upstreamAuthor}`,
    'Original License: MIT License (see LICENSE file included alongside this notice)',
    '',
    'Additional Third-Party Open-Source Attribution:',
    'Engineering Pack skills (studio/skills/) and Quality & Security auditor personas',
    'Adapted from addyosmani/agent-skills',
    'Repository: https://github.com/addyosmani/agent-skills',
    'Original Author: Copyright (c) 2025 Addy Osmani',
    'Original License: MIT License (see LICENSE file included alongside this notice)',
    '',
  ].join('\r\n');
}

function buildInstalledLaunchVbs() {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'appDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'installRoot = fso.GetParentFolderName(appDir)',
    'nodeExe = installRoot & "\\runtime\\node.exe"',
    'daemonJs = appDir & "\\studio\\daemon.mjs"',
    'dataDir = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\\SuperpowersStudio")',
    'WshShell.Environment("Process")("SUPERPOWERS_STUDIO_DATA_DIR") = dataDir',
    'WshShell.CurrentDirectory = appDir',
    'cmd = """" & nodeExe & """ """ & daemonJs & """ open --port 49500"',
    'WshShell.Run cmd, 0, False',
    '',
  ].join('\r\n');
}

function buildInstalledStopVbs() {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'appDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'installRoot = fso.GetParentFolderName(appDir)',
    'nodeExe = installRoot & "\\runtime\\node.exe"',
    'daemonJs = appDir & "\\studio\\daemon.mjs"',
    'dataDir = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\\SuperpowersStudio")',
    'WshShell.Environment("Process")("SUPERPOWERS_STUDIO_DATA_DIR") = dataDir',
    'WshShell.CurrentDirectory = appDir',
    'cmd = """" & nodeExe & """ """ & daemonJs & """ stop"',
    'WshShell.Run cmd, 0, True',
    '',
  ].join('\r\n');
}

function buildPostInstallVbs() {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'appDir = fso.GetParentFolderName(WScript.ScriptFullName)',
    'guideHtml = appDir & "\\GETTING-STARTED.html"',
    'launchVbs = appDir & "\\launch-studio.vbs"',
    'WshShell.Run "cmd.exe /c start """" """ & guideHtml & """", 0, False',
    'WshShell.Run "wscript.exe """ & launchVbs & """", 0, False',
    '',
  ].join('\r\n');
}

function collectFilesRecursive(dir, baseDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFilesRecursive(full, baseDir));
    } else if (entry.isFile()) {
      out.push({
        full,
        rel: path.relative(baseDir, full),
      });
    }
  }
  return out;
}

export function stagePackageFiles({
  repoRoot = REPO_ROOT,
  stageDir,
  includeNodeRuntime = true,
  nodeExecutable = process.execPath,
  version = DEFAULT_VERSION,
} = {}) {
  if (!stageDir) throw new Error('stageDir is required');
  fs.rmSync(stageDir, { recursive: true, force: true });
  ensureDir(stageDir);

  const runtimeDir = path.join(stageDir, 'runtime');
  const appDir = path.join(stageDir, 'app');
  const studioDst = path.join(appDir, 'studio');
  const skillsDst = path.join(appDir, 'skills');
  const assetsDir = path.join(stageDir, 'assets');

  ensureDir(runtimeDir);
  ensureDir(studioDst);
  ensureDir(skillsDst);
  ensureDir(assetsDir);

  // 1. Optional bundled Node.js runtime
  if (includeNodeRuntime) {
    fs.copyFileSync(nodeExecutable, path.join(runtimeDir, 'node.exe'));
  }

  // 2. Studio runtime code ONLY (strictly exclude tests, packaging, dist, user data)
  const studioSrc = path.join(repoRoot, 'studio');
  const versionInfo = { ...getVersionInfo(), version };
  for (const fileName of ['server.mjs', 'daemon.mjs']) {
    fs.copyFileSync(path.join(studioSrc, fileName), path.join(studioDst, fileName));
  }
  fs.writeFileSync(path.join(studioDst, 'version.json'), JSON.stringify(versionInfo, null, 2) + '\n', 'utf8');
  copyTreeFiltered(path.join(studioSrc, 'lib'), path.join(studioDst, 'lib'));
  copyTreeFiltered(path.join(studioSrc, 'public'), path.join(studioDst, 'public'));
  if (fs.existsSync(path.join(studioSrc, 'skills'))) {
    copyTreeFiltered(path.join(studioSrc, 'skills'), path.join(studioDst, 'skills'), {
      skipNames: new Set(['.git', 'node_modules', '.DS_Store']),
    });
  }

  // 3. All 15 live Superpowers skills (strictly read-only copy) + upstream MIT LICENSE + VIGGTech NOTICE
  copyTreeFiltered(path.join(repoRoot, 'skills'), skillsDst, {
    skipNames: new Set(['.git', 'node_modules', '.DS_Store']),
  });
  const rootLicense = path.join(repoRoot, 'LICENSE');
  if (fs.existsSync(rootLicense)) {
    fs.copyFileSync(rootLicense, path.join(appDir, 'LICENSE'));
  }
  fs.writeFileSync(path.join(appDir, 'NOTICE.txt'), buildNoticeTxt({ version, versionInfo }), 'utf8');

  // 4. Icon, license RTF, launchers, and Getting Started guide
  fs.writeFileSync(path.join(assetsDir, 'superpowers-studio.ico'), buildStudioIcoBuffer());
  fs.writeFileSync(path.join(assetsDir, 'LICENSE.rtf'), buildLicenseRtf({ version, versionInfo }), 'utf8');
  fs.writeFileSync(path.join(appDir, 'launch-studio.vbs'), buildInstalledLaunchVbs(), 'utf8');
  fs.writeFileSync(path.join(appDir, 'stop-studio.vbs'), buildInstalledStopVbs(), 'utf8');
  fs.writeFileSync(path.join(appDir, 'post-install.vbs'), buildPostInstallVbs(), 'utf8');
  fs.writeFileSync(path.join(appDir, 'GETTING-STARTED.html'), buildGettingStartedHtml({ version, versionInfo }), 'utf8');

  const files = collectFilesRecursive(stageDir, stageDir);
  return { stageDir, files };
}

function makeWixId(prefix, key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 14);
  return `${prefix}_${hash}`;
}

export function generateWixManifest({ stageDir, version = DEFAULT_VERSION } = {}) {
  const allFiles = collectFilesRecursive(stageDir, stageDir);

  // Group files by relative directory
  const dirTree = { name: '', rel: '', children: new Map(), files: [] };
  for (const f of allFiles) {
    const dirRel = path.dirname(f.rel);
    const parts = dirRel === '.' ? [] : dirRel.split(path.sep);
    let node = dirTree;
    let curRel = '';
    for (const part of parts) {
      curRel = curRel ? path.join(curRel, part) : part;
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, rel: curRel, children: new Map(), files: [] });
      }
      node = node.children.get(part);
    }
    node.files.push(f);
  }

  const componentIds = [];
  const indent = (n) => '  '.repeat(n);

  function renderDirNode(node, depth) {
    const lines = [];
    for (const f of node.files) {
      const normRel = f.rel.replace(/\\/g, '/');
      const isLaunchVbs = normRel === 'app/launch-studio.vbs';
      const isStopVbs = normRel === 'app/stop-studio.vbs';
      const isPostInstallVbs = normRel === 'app/post-install.vbs';
      const isGuideHtml = normRel === 'app/GETTING-STARTED.html';
      const compId = makeWixId('Cmp', normRel);
      const fileId = isLaunchVbs
        ? 'FileLaunchStudioVbs'
        : isStopVbs
          ? 'FileStopStudioVbs'
          : isPostInstallVbs
            ? 'FilePostInstallVbs'
            : isGuideHtml
              ? 'FileGettingStartedHtml'
              : makeWixId('Fil', normRel);
      componentIds.push(compId);
      lines.push(`${indent(depth)}<Component Id="${compId}" Guid="*">`);
      lines.push(`${indent(depth + 1)}<File Id="${fileId}" Source="${escapeXml(f.full)}" KeyPath="yes" />`);
      lines.push(`${indent(depth)}</Component>`);
    }
    for (const child of node.children.values()) {
      const dirId = makeWixId('Dir', child.rel.replace(/\\/g, '/'));
      lines.push(`${indent(depth)}<Directory Id="${dirId}" Name="${escapeXml(child.name)}">`);
      lines.push(...renderDirNode(child, depth + 1));
      lines.push(`${indent(depth)}</Directory>`);
    }
    return lines;
  }

  const icoSource = path.join(stageDir, 'assets', 'superpowers-studio.ico');
  const licenseSource = path.join(stageDir, 'assets', 'LICENSE.rtf');
  const bodyLines = renderDirNode(dirTree, 4);
  const compRefs = componentIds.map((id) => `      <ComponentRef Id="${id}" />`).join('\n');

  const versionInfo = getVersionInfo();
  const packageName = `${versionInfo.productName} (${versionInfo.edition})`;
  const manufacturer = versionInfo.publisher || 'VIGGTech';

  return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"
     xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
  <Package Name="${escapeXml(packageName)}"
           Manufacturer="${escapeXml(manufacturer)}"
           Version="${escapeXml(version)}"
           UpgradeCode="${UPGRADE_CODE}"
           Scope="perUser"
           Compressed="yes">
    <MajorUpgrade DowngradeErrorMessage="A newer version of Superpowers Studio is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />

    <Icon Id="StudioIcon.ico" SourceFile="${escapeXml(icoSource)}" />
    <Property Id="ARPPRODUCTICON" Value="StudioIcon.ico" />
    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Launch Superpowers Studio and open Getting Started Guide (Add API Keys)" />
    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1" />
    <WixVariable Id="WixUILicenseRtf" Value="${escapeXml(licenseSource)}" />

    <!-- Post-install launch (user-checked on Finish dialog) -->
    <CustomAction Id="LaunchPostInstall"
                  ExeCommand="wscript.exe &quot;[#FilePostInstallVbs]&quot;"
                  Directory="INSTALLFOLDER"
                  Execute="immediate"
                  Return="asyncNoWait" />

    <!-- Stop running Studio daemon cleanly on uninstall -->
    <CustomAction Id="StopStudioOnUninstall"
                  ExeCommand="wscript.exe &quot;[#FileStopStudioVbs]&quot;"
                  Directory="INSTALLFOLDER"
                  Execute="immediate"
                  Return="ignore" />

    <InstallExecuteSequence>
      <Custom Action="StopStudioOnUninstall" Before="RemoveFiles" Condition="REMOVE=&quot;ALL&quot;" />
    </InstallExecuteSequence>

    <UI>
      <ui:WixUI Id="WixUI_Minimal" />
      <Publish Dialog="ExitDialog"
               Control="Finish"
               Event="DoAction"
               Value="LaunchPostInstall"
               Condition="WIXUI_EXITDIALOGOPTIONALCHECKBOX = 1 and NOT Installed" />
    </UI>

    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="ProgramsDir" Name="Programs">
        <Directory Id="INSTALLFOLDER" Name="SuperpowersStudio">
${bodyLines.join('\n')}
        </Directory>
      </Directory>
    </StandardDirectory>

    <StandardDirectory Id="DesktopFolder">
      <Component Id="CmpDesktopShortcut" Guid="A93F7B21-6C4E-48D3-9D1A-5B3E1F2A8401">
        <Shortcut Id="DesktopStudioShortcut"
                  Name="Superpowers Studio"
                  Description="Launch and open Superpowers Studio"
                  Target="[System64Folder]wscript.exe"
                  Arguments="&quot;[#FileLaunchStudioVbs]&quot;"
                  WorkingDirectory="INSTALLFOLDER"
                  Icon="StudioIcon.ico" />
        <RegistryValue Root="HKCU" Key="Software\\SuperpowersStudio" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </StandardDirectory>

    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="StudioStartMenuDir" Name="Superpowers Studio">
        <Component Id="CmpStartMenuShortcuts" Guid="B41E8D52-3F20-4B6A-8C92-7D14E6C3B502">
          <Shortcut Id="StartMenuStudioShortcut"
                    Name="Superpowers Studio"
                    Description="Launch and open Superpowers Studio"
                    Target="[System64Folder]wscript.exe"
                    Arguments="&quot;[#FileLaunchStudioVbs]&quot;"
                    WorkingDirectory="INSTALLFOLDER"
                    Icon="StudioIcon.ico" />
          <Shortcut Id="StartMenuGuideShortcut"
                    Name="Getting Started Guide"
                    Description="How to add API keys and start your first Superpowers Studio session"
                    Target="[#FileGettingStartedHtml]"
                    WorkingDirectory="INSTALLFOLDER"
                    Icon="StudioIcon.ico" />
          <Shortcut Id="StartMenuStopShortcut"
                    Name="Stop Superpowers Studio"
                    Description="Stop the Superpowers Studio background daemon"
                    Target="[System64Folder]wscript.exe"
                    Arguments="&quot;[#FileStopStudioVbs]&quot;"
                    WorkingDirectory="INSTALLFOLDER"
                    Icon="StudioIcon.ico" />
          <RemoveFolder Id="RemoveStartMenuDir" On="uninstall" />
          <RegistryValue Root="HKCU" Key="Software\\SuperpowersStudio" Name="StartMenuShortcuts" Type="integer" Value="1" KeyPath="yes" />
        </Component>
      </Directory>
    </StandardDirectory>

    <Feature Id="MainFeature" Title="Superpowers Studio" Level="1">
${compRefs}
      <ComponentRef Id="CmpDesktopShortcut" />
      <ComponentRef Id="CmpStartMenuShortcuts" />
    </Feature>
  </Package>
</Wix>
`;
}

export function buildMsi({
  repoRoot = REPO_ROOT,
  outDir = path.join(STUDIO_ROOT, 'dist'),
  version = DEFAULT_VERSION,
  includeNodeRuntime = true,
} = {}) {
  ensureDir(outDir);
  const stageDir = path.join(outDir, 'stage');
  stagePackageFiles({ repoRoot, stageDir, includeNodeRuntime, version });

  const wxsPath = path.join(outDir, 'SuperpowersStudio.wxs');
  const publisherSlug = String(getVersionInfo().publisher || 'VIGGTech').replace(/[^a-zA-Z0-9_-]/g, '');
  const msiName = `SuperpowersStudio-${publisherSlug}-${version}-x64.msi`;
  const msiPath = path.join(outDir, msiName);

  const wxs = generateWixManifest({ stageDir, version });
  fs.writeFileSync(wxsPath, wxs, 'utf8');

  execFileSync(
    'wix',
    [
      'build',
      '-arch', 'x64',
      '-ext', 'WixToolset.UI.wixext/5.0.2',
      '-o', msiPath,
      wxsPath,
    ],
    { stdio: 'inherit', cwd: repoRoot }
  );

  const stat = fs.statSync(msiPath);
  return {
    msiPath,
    sizeBytes: stat.size,
    sizeMB: Number((stat.size / (1024 * 1024)).toFixed(2)),
    version,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  let version = DEFAULT_VERSION;
  let includeNodeRuntime = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i + 1]) version = args[++i];
    else if (args[i] === '--no-node') includeNodeRuntime = false;
  }
  const res = buildMsi({ version, includeNodeRuntime });
  console.log(JSON.stringify({ ok: true, ...res }, null, 2));
}
