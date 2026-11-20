# Superpowers Studio — VIGGTech Edition (v1.0.0)

> **Open Source (MIT License)** · Built by **VIGGTech** · Derived from **[obra/superpowers](https://github.com/obra/superpowers) v7.0.2**
>
> **Repository:** https://github.com/VIGGTech/superpower-studio · **Windows Installer:** [Releases](https://github.com/VIGGTech/superpower-studio/releases)

Superpowers Studio is a **zero-runtime-dependency Node.js** multi-provider autonomous agent environment that pairs a local web dashboard with **23 live skills** across two modular packs (**15 Superpowers Core workflow skills** in `skills/` + **8 curated Engineering Pack skills** in `studio/skills/` with bundled checklists) and **12 built-in Specialist Experts**. It lets you run one or more parallel autonomous coding, security/performance auditing, research, and visual-production sessions using any combination of AI providers.

---

## How It Works

### 1. Three-Tier Autonomous Agent Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  YOU (Desktop Browser / Mobile Phone via LAN or Tailscale QR)          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ Chat, images, Quick Actions, Pause/Resume
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  TIER 1: SUBORDINATE AGENT (Human Interface & Supervisor Watchdog)      │
│  • Interviews you, clarifies requirements, drafts Rules & Plan          │
│  • Stays responsive mid-run — never blocked by heavy execution          │
│  • Relays course corrections cleanly at Coordinator turn boundaries     │
│  • Watchdog auto-recovers stalled or errored Coordinator turns          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ Approve & Dispatch (locks immutable Rules)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  TIER 2: COORDINATOR AGENT (Autonomous Execution Lead)                  │
│  • Runs in background Node.js loop (survives closing your browser)      │
│  • Executes plan tasks, tracks Mission Board (Done / Working / Next)    │
│  • Enforces 100% Task Completion Gate when Auto-Continue is ON          │
│  • Dispatches parallel Specialist Experts & inspects visual outputs     │
└──────────────┬─────────────────────────────┬────────────────────────────┘
               │ parallel spawn_expert()     │ parallel spawn_expert()
               ▼                             ▼
┌──────────────────────────────┐  ┌───────────────────────────────────────┐
│  TIER 3: SPECIALIST EXPERTS  │  │  TIER 3: SPECIALIST EXPERTS           │
│  • Software Implementer      │  │  • Security Auditor (read-only)       │
│  • Code Reviewer (read-only) │  │  • Web Performance Auditor (r/o)      │
│  • Systematic Debugger       │  │  • Accessibility Auditor (read-only)  │
│  • Technical Researcher      │  │  • QA & Test Engineer                 │
│  • + Medical & Imaging (4)   │  │  • + Your Custom Experts              │
│  (All inherit locked Rules!) │  │  (Parallel fan-out via spawn_expert)  │
└──────────────────────────────┘  └───────────────────────────────────────┘
```

### 2. Core Capabilities Under the Hood
- **Uninterrupted Supervisor (`Auto-Continue: ON`):**
  - Bypasses arbitrary turn limits so long multi-hour builds don't pause prematurely.
  - **100% Goal-Completion Gate:** Rejects premature `report_complete` calls if any Mission Board task is still `pending`, `in_progress`, or `blocked`.
  - **Autonomous Watchdog Recovery:** Detects stalled loops (3 consecutive text-only turns, 5 consecutive identical tool errors, or transient API errors), wakes the Subordinate to diagnose and relay a recovery directive, and restarts the Coordinator automatically.
- **23 Live Skills (Multi-Pack Architecture, Single Router):**
  - **Superpowers Core (15 skills in `skills/`):** `brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, `subagent-driven-development`, `verification-before-completion`, etc. — with `using-superpowers` kept as the single active router.
  - **Engineering Pack (8 curated skills in `studio/skills/`, adapted from `addyosmani/agent-skills`):** `security-and-hardening`, `api-and-interface-design`, `frontend-ui-engineering`, `code-simplification`, `doubt-driven-development`, `constraint-driven-development`, `performance-optimization`, and `accessibility-engineering` — each bundled with self-contained `references/` checklists.
  - Trigger any skill with `/skill-name` in chat, filter by pack in the **Skills** tab, inspect bundled checklists, or pin skills per session.
- **Automatic Git Worktree Isolation:** When two sessions target the same Git repository concurrently, Studio automatically creates an isolated `git worktree` branch (`superpowers/<session-id>`) so agents never overwrite each other's files.
- **Multimodal Vision & Visual Companion:**
  - Paste (`Ctrl+V`), drag-and-drop, or upload reference images (`+ Image`) — translated across OpenAI-compatible, Anthropic, and Gemini APIs (with automatic per-request image-budget capping and text-only fallback).
  - Agents can visually inspect rendered workspace `.png`/`.svg`/`.jpg`/`.webp` outputs with `view_workspace_image`.
  - The **Visual** tab safely inlines local workspace images inside a strict `sandbox="allow-scripts"` iframe, includes a **Screen Switcher** dropdown, and provides an **`Outputs`** gallery of all generated images in the workspace.
- **Background Daemon & Mobile Access:**
  - All agent loops run inside the Node.js backend — closing your browser never stops work.
  - Supports a detached background daemon, auto-resume after server restarts, optional Windows logon auto-start, one-click Windows Desktop/Start Menu icons, responsive mobile phone navigation, and a 100%-local SVG QR code for **Wi-Fi LAN** and **Tailscale VPN**.

---

## Installation

### Option A — Windows `.msi` Installer (Recommended, Zero Prerequisites)
1. Download **`SuperpowersStudio-VIGGTech-1.0.0-x64.msi`** from [GitHub Releases](https://github.com/VIGGTech/superpower-studio/releases).
2. Double-click to install (per-user install into `%LOCALAPPDATA%\Programs\SuperpowersStudio` — **no admin/UAC required**, Node.js v20 is bundled).
3. On the Finish screen, leave **"Launch Superpowers Studio and open Getting Started Guide"** checked — Studio starts in the background and opens in your browser automatically.

### Option B — Run From Source (Node.js 20+, Windows / macOS / Linux)
```powershell
git clone https://github.com/VIGGTech/superpower-studio.git
cd superpower-studio

# Start detached in the background and open your browser:
node studio/daemon.mjs open

# Or run in the foreground:
node studio/server.mjs
```

---

## How to Use Superpowers Studio

### Step 1 — Add Your API Keys
1. Click **1. Configure API Keys** on the welcome screen (or **Providers & Models** in the bottom-left sidebar).
2. Pick any pre-configured provider — **Anthropic (Claude)**, **Google Gemini**, **DeepSeek**, **Alibaba Qwen**, **Abliteration.ai**, **OpenRouter**, **Ollama (local)** — or click **+ Add Custom API** for any OpenAI-compatible endpoint (vLLM, LM Studio, LiteLLM, etc.).
3. Paste your API key (or set the matching environment variable), click **Fetch Models** to populate the full model dropdown (with a **`Custom model ID…`** fallback across all modals), click **Test Connection** to verify, and click **Save Provider**.

### Step 2 — Start a New Session
1. Click **+ New Session** in the left sidebar.
2. Enter a **Session Title** and **Target Workspace Directory** (checked by default to auto-create the folder if it doesn't exist yet).
3. Choose providers & models per tier from the fetched model dropdowns (or **`Custom model ID…`**):
   - **Subordinate:** conversational planning & watchdog supervision
   - **Coordinator:** autonomous execution lead (optional — inherits Subordinate if blank)
   - **Default Experts:** specialist subagents (optional — inherits Coordinator if blank)
4. Pick your **Skill Packs** (Superpowers Core stays on as the primary router; toggle **Engineering Pack** per session) and **Active Experts** using one-click presets (**All**, **Software & Web**, **Medical & Imaging**, **None**) or individual checkboxes.
5. Keep **Run uninterrupted until 100% complete** checked for hands-free execution, and click **Create Session**.
   - *Tip:* Click **Settings** (or the `Sub: ... · Coord: ...` pill) anytime to change models, skill packs, or active experts live — or open **Expert Roster** to toggle experts for the active session and customize each expert's auto-loaded **Default Skills** (tag chips + grouped **`+ Add skill…`** dropdown).

### Step 3 — Interview, Refine & Dispatch
1. Chat with the **Subordinate** to describe your goal. Paste reference images with `Ctrl+V` (or drag-and-drop / click `+ Image`), or type `/skill-name` to invoke any Superpowers skill.
2. Click one-click **Suggested** or **Quick Actions** buttons (`Proceed`, `Draft Rules & Plan`, `Approve & Dispatch`) right above the composer.
3. Review or edit the **Rules & Plan** drawer if needed, then click **Approve & Dispatch**.
   - Rules are locked and inherited by the Coordinator and every spawned Expert.
   - Numbered/headed plan items are automatically parsed into the live **Mission Progress** board (`Working On` / `Up Next` / `Done` + rolling ETA).

### Step 4 — Monitor, Inspect & Steer Mid-Run
- **Resizable Layout:** Drag the vertical dividers between the left sidebar, chat pane, and right inspector (double-click any divider to reset; widths persist across reloads).
- **Agents Tab:** Watch live **Subordinate → Coordinator → Active Experts** activity. Completed Experts and `Done Tasks` auto-collapse into expandable drawers so active work stays pinned at the top. Click **Inspect Transcript** on any Expert to audit its full tool trace.
- **Visual Tab:** Switch between **Screens** (sandboxed HTML screens pushed by agents with automatic workspace image inlining + screen dropdown) and **Outputs** (thumbnail gallery of every `.png`/`.svg`/`.jpg`/`.webp` rendered in the workspace with click-to-zoom lightbox).
- **Steer Without Stopping:** Keep chatting with the Subordinate anytime, or type instructions and click **Relay to Coordinator** to inject a directive cleanly at the next turn boundary.
- **Pause / Stop / Retry:** Use **Auto-Continue: ON/OFF** in the mission bar, **Pause**, **Stop**, or **Retry / Resume** anytime.
- **Delete / Purge Session:** Click the **`×`** button on a session card (or **Delete / Purge Session…** inside **Settings**) to cleanly erase session history, force-remove its isolated worktree & `superpowers/*` branch, and optionally delete a dedicated workspace folder (protected folders such as the Studio repo, home directory, or folders shared by another session can never be accidentally deleted).

### Step 5 — Background Persistence, Windows Auto-Start & Mobile Access
Click **Background & Service** in the bottom-left sidebar to configure:
- **Auto-Resume After Server Restart:** Automatically repairs interrupted tool calls and resumes `Auto-Continue: ON` sessions when Studio restarts.
- **Windows Background Service (Optional):** Registers a hidden Windows Task Scheduler logon task (`SuperpowersStudioBackground`, zero admin/UAC required) so Studio starts silently after a PC reboot.
- **One-Click Windows Icon:** Creates Desktop & Start Menu shortcuts that launch Studio silently (if not running) and open your browser directly into the dashboard.
- **Mobile Access (Same Wi-Fi LAN + Tailscale VPN):**
  1. Click **Enable Mobile / LAN & Tailscale Access** and restart Studio once so it binds to `0.0.0.0`.
  2. Pick your **Local Wi-Fi / LAN** or **Tailscale VPN** (`100.x.y.z`) endpoint and scan the locally-generated **QR code** with your phone camera.
  3. On mobile (`≤ 860px`), Studio switches to a full-screen phone interface with a bottom navigation bar (**Sessions | Chat | Agents | Visual**). Tap **Add to Home Screen** in iOS Safari or Android Chrome for an app-like experience.

---

## CLI Reference

```powershell
# Detached background daemon & shortcuts
node studio/daemon.mjs open                 # Start daemon if needed & open browser
node studio/daemon.mjs start                # Start detached background daemon
node studio/daemon.mjs status               # Check daemon, Windows auto-start & shortcuts
node studio/daemon.mjs logs --lines 80      # View daemon logs
node studio/daemon.mjs restart              # Restart background daemon
node studio/daemon.mjs stop                 # Stop background daemon
node studio/daemon.mjs install-service      # Register hidden Windows logon auto-start
node studio/daemon.mjs uninstall-service    # Remove Windows logon auto-start
node studio/daemon.mjs install-shortcuts    # Create Windows Desktop & Start Menu icons
node studio/daemon.mjs uninstall-shortcuts  # Remove Windows Desktop & Start Menu icons

# Testing & Windows MSI Packaging
node --test studio/tests                    # Run full Studio test suite
node studio/packaging/build-msi.mjs         # Build self-contained x64 .msi (requires WiX v5)
```

---

## Privacy & Security
- **100% Local Data:** API keys, sessions, attachments, and your persistent auth token are stored locally (`.superpowers-studio/` from source, or `%LOCALAPPDATA%\SuperpowersStudio` when installed via MSI). Nothing is sent to VIGGTech or any telemetry service.
- **Token + Origin Auth:** Every API & WebSocket request requires a 48-char token (`HttpOnly; SameSite=Strict` cookie) plus strict `Origin` validation (localhost-only by default; LAN/Tailscale IPv4 + `*.ts.net` only when Mobile Access is explicitly enabled).
- **Workspace Containment:** File tools and visual previews enforce strict realpath scoping inside the session's workspace/worktree.
- **Sandboxed Visual Companion:** Renders agent HTML inside `<iframe sandbox="allow-scripts">` (never `allow-same-origin`).

## Open-Source License & Attribution
Released under the **MIT License** — see [LICENSE](../LICENSE) and [NOTICE.txt](../NOTICE.txt).
- Derived from **[obra/superpowers](https://github.com/obra/superpowers) v7.0.2** (Copyright © 2025 Jesse Vincent, MIT License).
- Engineering Pack skills (`studio/skills/`) and Quality & Security auditor personas adapted from **[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)** (Copyright © 2025 Addy Osmani, MIT License).
