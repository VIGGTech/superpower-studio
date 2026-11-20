# Superpowers Studio — Multi-Provider Autonomous Agent Environment Design

**Date:** 2026-11-19
**Status:** Approved (updated with full 15-skill UI catalog & invocation requirement)

---

## 1. Intent & Why

`obra/superpowers` provides a battle-tested library of 15 engineering workflow skills (brainstorming, planning, TDD, systematic debugging, subagent-driven development, code review, verification) and a visual companion server, but it has no standalone agent runtime—it relies on external coding-agent harnesses such as Claude Code, Codex, Cursor, OpenCode, or Antigravity.

The goal of **Superpowers Studio** is to turn this repository into a self-contained, harness-independent agentic environment that works with **any model provider**—including Anthropic (Claude), Google (Gemini), Qwen, DeepSeek, and custom OpenAI-compatible APIs such as **Abliteration.ai** (`https://api.abliteration.ai/v1`).

A normal user session follows a **3-tier agent hierarchy** across **one or more simultaneous sessions**:

```text
You (Human) ──► Subordinate Agent ──► Coordinator Agent ──► Experts / Subagents
                 (Interview, Rules,     (Autonomous Lead,      (Coder, Debugger,
                  Relay & Reporting)     Plan Execution, QA)    Reviewer, Researcher...)
```

1. **Interview & Rules Phase (with Subordinate):** You talk directly to the **Subordinate** agent. Driven by Superpowers' `brainstorming` and `writing-plans` skills, the Subordinate interviews you to lock down goals, constraints, rules, and an implementation plan.
2. **Relay & Autonomous Execution Phase (Subordinate → Coordinator → Experts):** Once you approve the locked rules/plan, the Subordinate relays the mission brief to the **Coordinator** agent. The Coordinator runs autonomously in the background—decomposing work, dispatching specialist **Experts/Subagents** in parallel or sequence, running tests, and verifying results—while the Subordinate stays responsive to your chat messages at any time to report progress, answer questions, or relay new instructions to the Coordinator.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Standalone execution:** Starts directly with Node.js (`node studio/server.mjs`) with zero reliance on Antigravity or any other IDE harness.
- **Any model provider:** Native HTTP adapters for Anthropic Messages API, Google Gemini REST API, and generic OpenAI-compatible Chat Completions APIs (DeepSeek, Qwen/DashScope, Abliteration.ai, OpenRouter, Ollama, or any custom base URL + API key).
- **Reliable tool calling across open/abliterated models:** Supports native provider tool calling plus a prompt-based structured tool-call fallback (`toolMode: "native" | "prompt" | "auto"`) so endpoints or abliterated weights without reliable native `tool_calls` still execute tools cleanly.
- **Simultaneous parallel sessions:** Multiple independent sessions run concurrently in one local web dashboard, each with its own workspace, provider/model selection (plus optional subagent model override), rules, conversation stream, and subagent tree.
- **Full workspace autonomy with safe parallel isolation:** After interview approval, agents freely read/write files and run shell commands scoped to the session's workspace. When two active sessions target the same git repository, Studio automatically isolates the second session in a dedicated `git worktree` so parallel runs cannot overwrite each other's files.
- **Live Superpowers skill integration:** Reads all 15 skills directly from `../skills/*/SKILL.md` without modifying upstream `obra/superpowers` files, bootstraps `using-superpowers` at session start, and embeds the Visual Companion directly in the dashboard.
- **Local persistence:** Sessions, rules, transcripts, subagent logs, and provider configs persist locally in `.superpowers-studio/` (gitignored).

### Non-Goals
- Modifying upstream `skills/`, `hooks/`, or `tests/` in `obra/superpowers` (all existing repo tests must continue passing untouched).
- Multi-user cloud hosting, remote user accounts, or billing. Studio is local-first for a single developer.
- OS-level container/Docker sandboxing in v1 (isolation uses workspace path scoping + git worktrees).

### Anti-Goals
- Agents editing project files or running mutating shell commands before the user approves the interview rules/plan.
- Hanging sessions silently when a provider returns malformed SSE chunks, rate limits, or unsupported tool schemas.
- Blocking one session while another session is streaming tokens or waiting on a long shell command.
- Exposing local shell execution to arbitrary websites open in other browser tabs.

---

## 3. Constraints

- **Runtime:** Node.js 20.19+ (tested on Windows with PowerShell/Git Bash, also compatible with macOS/Linux).
- **Dependencies:** Zero runtime npm dependencies and zero frontend build step (`studio/` uses Node built-in `http`, `fs`, `path`, `crypto`, `child_process`, global `fetch`, and a lightweight RFC 6455 WebSocket server module following the pattern in `skills/brainstorming/scripts/server.cjs`).
- **Repo cleanliness:** All Studio source lives under `studio/`. All runtime state (sessions, provider configs, API keys, auto-created worktrees) lives under `.superpowers-studio/` (added to `.gitignore`, overrideable via `SUPERPOWERS_STUDIO_DATA_DIR`).
- **Localhost security:** Binds to `127.0.0.1` by default (port `49500`, configurable via `--port` / `--host`), gated by a per-launch session token (`?token=...` → `HttpOnly; SameSite=Strict` cookie) plus strict `Origin` verification on all mutating HTTP routes and WebSocket upgrades.

---

## 4. Approaches Considered

| Approach | Summary | Tradeoffs |
| --- | --- | --- |
| **1. Native Node.js Runtime + Lightweight Web Studio in `studio/` (Selected)** | Self-contained Node.js ESM server with 3 native HTTP provider adapters (Anthropic, Gemini, OpenAI-compatible with prompt-tool fallback), zero-build SPA dashboard over HTTP + WebSocket, and embedded Visual Companion. | Fast startup on Windows, zero bundler/dependency friction, full control over quirky/abliterated OpenAI-compatible APIs and reasoning streams. Tradeoff: we own and maintain the 3 adapters and UI code directly. |
| **2. Node.js + Vercel AI SDK + React/Vite** | Uses `@ai-sdk/*` packages on backend and React/Vite frontend. | Standardized SDK adapters and React state ergonomics, but adds heavy dependency trees, a frontend build step, and less control over non-standard tool-calling fallbacks. |
| **3. Python (FastAPI + LiteLLM) + Web UI** | FastAPI backend using LiteLLM for 100+ providers. | Broad instant provider catalog, but introduces Python virtualenv + heavy dependency footprint alongside an otherwise Node.js repo and trickier Windows async subprocess handling. |

The human partner selected **Approach 1**.

---

## 5. Architecture & Detailed Design

### 5.1 Directory Layout

```text
studio/
├── server.mjs                 # CLI entrypoint, HTTP + WebSocket server, auth middleware
├── lib/
│   ├── ws.mjs                 # Zero-dep RFC 6455 WebSocket server (frames, ping/pong, broadcast)
│   ├── store.mjs              # Persistent JSON / JSONL storage under .superpowers-studio/
│   ├── skills.mjs             # Live loader for ../skills/*/SKILL.md + bootstrap prompt builder
│   ├── worktree.mjs           # Git repo detection & automatic worktree isolation for parallel sessions
│   ├── tools.mjs              # Scoped file/search/shell/skill/visual/subagent tool executor
│   ├── orchestrator.mjs       # Multi-session state machine, main agent loop, subagent manager
│   └── providers/
│       ├── index.mjs          # Provider registry, presets, model discovery (/v1/models), dispatch
│       ├── openai-compat.mjs  # OpenAI-compatible adapter (Abliteration.ai, DeepSeek, Qwen, etc.)
│       ├── anthropic.mjs      # Native Anthropic Messages API adapter
│       ├── gemini.mjs         # Native Google Gemini REST API adapter
│       └── prompt-tools.mjs   # Prompt-based <tool_call> fallback serializer & streaming parser
├── public/
│   ├── index.html             # Single-page Studio dashboard shell
│   ├── styles.css             # OS light/dark theme aligned with Superpowers frame-template.html
│   └── app.js                 # Frontend WebSocket client, multi-session UI, modals, companion bridge
└── tests/                     # Node built-in test runner (node --test) unit & integration suites
```

### 5.2 Provider & Model Configuration

Stored in `.superpowers-studio/providers.json`. Each profile has:

```json
{
  "id": "abliteration",
  "name": "Abliteration.ai",
  "kind": "openai-compatible",
  "baseUrl": "https://api.abliteration.ai/v1",
  "apiKey": "",
  "envVar": "ABLIT_KEY",
  "defaultModel": "abliterated-model",
  "models": [],
  "toolMode": "auto",
  "extraHeaders": {}
}
```

**Built-in presets seeded on first launch** (all editable/deletable, plus users can add arbitrary custom providers):
1. **Anthropic (Claude)** — `kind: "anthropic"`, `baseUrl: "https://api.anthropic.com"`, `envVar: "ANTHROPIC_API_KEY"`, `toolMode: "native"`
2. **Google (Gemini)** — `kind: "gemini"`, `baseUrl: "https://generativelanguage.googleapis.com/v1beta"`, `envVar: "GEMINI_API_KEY"`, `toolMode: "native"`
3. **DeepSeek** — `kind: "openai-compatible"`, `baseUrl: "https://api.deepseek.com/v1"`, `envVar: "DEEPSEEK_API_KEY"`, `toolMode: "native"`
4. **Qwen (DashScope)** — `kind: "openai-compatible"`, `baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"`, `envVar: "DASHSCOPE_API_KEY"`, `toolMode: "native"`
5. **Abliteration.ai** — `kind: "openai-compatible"`, `baseUrl: "https://api.abliteration.ai/v1"`, `envVar: "ABLIT_KEY"` (also falls back to `ABLITERATION_API_KEY`), `toolMode: "auto"`
6. **OpenRouter** — `kind: "openai-compatible"`, `baseUrl: "https://openrouter.ai/api/v1"`, `envVar: "OPENROUTER_API_KEY"`, `toolMode: "auto"`
7. **Local Ollama** — `kind: "openai-compatible"`, `baseUrl: "http://localhost:11434/v1"`, `apiKey: "ollama"`, `toolMode: "auto"`

**Key resolution order:** Profile's saved `apiKey` (if non-empty) → `process.env[profile.envVar]`. API responses to the UI always mask saved keys (`sk-...1234` or boolean `hasKey`) so raw secrets are never unnecessarily echoed back.

**Provider Actions in UI:**
- **Fetch Models:** For `openai-compatible` providers, calls `GET {baseUrl}/models` to populate the model dropdown automatically (for Anthropic/Gemini, provides curated defaults + free-text model ID input + Gemini `GET /models` support).
- **Test Connection:** Sends a lightweight validation request (model list or minimal 1-token completion) and reports latency + status.

**Unified Streaming Adapter Interface:**
Every adapter implements:
```js
streamChat({ provider, model, systemPrompt, messages, tools, signal, onText, onReasoning })
// Resolves to: { content: string, reasoning: string, toolCalls: Array<{ id, name, arguments }>, usage, stopReason }
```
- Captures `reasoning_content` / Anthropic `thinking` blocks / Gemini thought parts into `reasoning` so reasoning models (DeepSeek R1, Claude thinking, QwQ, abliterated reasoning models) render cleanly in collapsible reasoning blocks.
- **`toolMode` behavior:**
  - `"native"`: Sends provider-native tool definitions.
  - `"prompt"`: Injects tool definitions into the system prompt with `<tool_call>{"name":"...","arguments":{...}}</tool_call>` instructions and parses emitted tags from the response.
  - `"auto"`: Attempts native tool calling first; if the provider returns HTTP 400/422 indicating unsupported tools/functions, automatically caches fallback for that `(providerId, model)` and retries transparently in `"prompt"` mode.

### 5.3 Session Lifecycle & 3-Tier Agent Hierarchy (Subordinate → Coordinator → Experts)

Each session persists under `.superpowers-studio/sessions/<sessionId>/`:
- `session.json` — metadata, phase, workspace paths, tier provider/model choices (`providerId`/`model` for Subordinate, optional `coordinatorProviderId`/`coordinatorModel`, optional `expertProviderId`/`expertModel`), locked `rules` & `plan`, turn counters.
- `messages.jsonl` — append-only conversation history between the user and the **Subordinate** agent.
- `coordinator.json` — **Coordinator** agent state, status (`idle | running | paused | completed | failed | stopped`), relayed directives queue, and full message/tool transcript.
- `experts/<expertId>.json` — each spawned **Expert/Subagent**'s metadata, role/specialty, status, model, and transcript.
- `screens/` — HTML fragments pushed to this session's Visual Companion.
- `events.jsonl` — user click events captured from this session's Visual Companion.

**Tier Responsibilities:**
- **Subordinate Agent (Human-Facing):** Always talks to the human. Conducts the upfront interview, drafts `rules` & `plan`, never edits project files or runs mutating shell commands directly, relays approved instructions & mid-run course corrections to the Coordinator, answers human status questions while the Coordinator runs in the background, and presents the Coordinator's escalations or final verified summary back to the human.
- **Coordinator Agent (Autonomous Execution Lead):** Receives locked `rules`, `plan`, and relayed instructions from the Subordinate. Runs an autonomous background loop inside `effectiveWorkDir`, loads execution skills (`subagent-driven-development`, `dispatching-parallel-agents`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, etc.), spawns and coordinates **Experts/Subagents** (sequentially or in parallel), integrates and verifies changes, escalates blockers upward to the Subordinate (`escalate_to_subordinate`), and reports completion upward (`report_complete`).
- **Experts / Subagents (Specialists):** Spawned by the Coordinator with a specific `role`/`specialty` (e.g., Implementer, Test Engineer, Code Reviewer, Debugger, Researcher), inheriting the locked `rules` automatically and returning structured results to the Coordinator.

**Phases:**
1. **`interview`** (initial state):
   - User interacts with the **Subordinate**. System prompt injects `skills/using-superpowers/SKILL.md`, `skills/brainstorming/SKILL.md`, all 15 skill summaries, and Subordinate Interview constraints.
   - Allowed Subordinate tools: `read_file`, `list_files`, `search_files`, `load_skill`, `push_visual_screen`, `read_visual_events`, and `propose_rules`.
   - The Coordinator is `idle`; no mutating file/shell/expert tools are active.
   - When requirements and rules are settled, Subordinate calls `propose_rules({ rulesMarkdown, planMarkdown })`, moving the session to `ready`.
2. **`ready`**:
   - Rules and plan are drafted and awaiting user sign-off (editable in the UI).
   - User clicks **"Approve & Dispatch to Coordinator"** (also available early from `interview` if the user wants to lock rules manually).
3. **`running`** (Coordinator autonomous execution, Subordinate stays interactive):
   - Studio locks `rules` and `plan`, runs workspace/git-worktree isolation (Section 5.4), and dispatches the mission brief from Subordinate → **Coordinator**.
   - **Coordinator loop:** Runs autonomously turn-by-turn with full execution + `spawn_expert` tools until it calls `report_complete({ summary, verification })` or `escalate_to_subordinate({ question, context })`.
   - **Text-only turn handling on Coordinator (Designer's call):** If the Coordinator emits text with zero tool calls (without calling `report_complete` or `escalate_to_subordinate`), Studio automatically sends up to **2** internal continuation nudges; on a 3rd consecutive text-only turn, Coordinator transitions to `paused` and notifies Subordinate.
   - **Live chat with Subordinate & mid-run relay (Designer's call):** While Coordinator is `running`, any user message sent via `POST /api/sessions/:id/messages` goes immediately to the **Subordinate** (which responds right away!). Subordinate can call `get_coordinator_status()` to report progress, `relay_to_coordinator({ instructions })` to queue a course correction at the Coordinator's next turn boundary (preserving strict tool-call/tool-result pairing across Anthropic/OpenAI/Gemini), or `pause_coordinator` / `resume_coordinator`.
   - **Upward reporting:** When Coordinator calls `escalate_to_subordinate` (pausing Coordinator) or `report_complete` (completing Coordinator), Studio automatically triggers a Subordinate turn to summarize the blocker or final verified result clearly to the human.
   - **Context-window management (Designer's call):** Full lossless transcripts persist on disk (`messages.jsonl`, `coordinator.json`, `experts/*.json`), while outbound LLM requests pin system prompt + locked `rules`/`plan` + recent turns and progressively trim older large tool outputs when approaching context limits or on provider overflow errors (retrying once before pausing).
   - **Safety guardrails (Designer's call):** Default Coordinator `maxTurns: 100` per run, Expert `maxTurns: 40`, max Expert nesting depth `2`, and a 5-strike identical-tool-error circuit breaker.
4. **`paused`**:
   - Triggered by the user clicking **Pause**, Coordinator calling `escalate_to_subordinate`, hitting turn cap, 3 consecutive text-only Coordinator turns, or a recoverable error. User can chat with Subordinate or click **Resume** to continue Coordinator execution.
5. **`completed` / `failed` / `stopped`**:
   - Terminal states.
   - **Reopening terminal sessions (Designer's call):** Sending a new message to a `completed`, `failed`, or `stopped` session goes to the **Subordinate**, which can answer directly or relay follow-up work to the Coordinator under the locked rules/plan (re-checking worktree isolation). An explicit **"Re-open Interview"** action (`POST /api/sessions/:id/reopen-interview`) returns to read-only `interview` phase so rules/plan can be edited and re-approved.
6. **Server restart recovery (Designer's call):**
   - On `studio/server.mjs` startup, any persisted session or Coordinator found in `running` is reconciled to `paused` with a system notice, and any orphaned `running` Experts are marked `stopped`, so restarting Studio never silently launches unattended shell commands.

### 5.4 Workspace Scoping & Automatic Git Worktree Isolation

When a session transitions to `running`:
- Studio checks all other currently active (`running` or `paused`) sessions.
- **No conflict:** `effectiveWorkDir = workspacePath`.
- **Conflict on a Git repo** (another active session already owns the same git top-level directory):
  - Studio runs `git worktree add -b superpowers/<sessionId> <dataDir>/worktrees/<sessionId> HEAD` inside `workspacePath`.
  - Sets `effectiveWorkDir` to the new worktree path and records `worktreeBranch` in `session.json` (displayed prominently in the session header with a note that changes live on that branch).
- **Conflict on a non-git folder:** Warns the user in the UI and asks whether to proceed in the shared folder or pick another directory before starting.
- **Worktree lifecycle on completion and delete (Designer's call):**
  - When a session completes, Studio **keeps** both the worktree and its `superpowers/<sessionId>` branch intact so the user can review, merge, or cherry-pick the work.
  - When `DELETE /api/sessions/:id` is called on a session with an auto-created worktree, Studio removes the worktree directory *only* if `git status --porcelain` is clean (always retaining the `superpowers/<sessionId>` git branch so commits are never silently lost). If uncommitted changes exist, `DELETE` returns HTTP `409 Conflict` with the dirty file list unless `?force=true` is explicitly confirmed in the UI.
- **Path enforcement:** Every file tool (`read_file`, `write_file`, `edit_file`, `list_files`, `search_files`) canonicalizes paths (`path.resolve` + `fs.realpathSync` check where existing) and rejects any access outside `effectiveWorkDir`.

### 5.5 Built-in Tool Suite (Scoped by Agent Tier)

| Tool | Available To | Purpose |
| --- | --- | --- |
| `read_file` | Subordinate, Coordinator, Expert | Read file with optional `startLine`/`endLine` (max 800 lines / 48KB per call). |
| `list_files` | Subordinate, Coordinator, Expert | List files/directories with optional glob/depth filter, skipping `.git` and `node_modules` by default. |
| `search_files` | Subordinate, Coordinator, Expert | Recursive text/regex search inside `effectiveWorkDir` with line numbers. |
| `load_skill` | Subordinate, Coordinator, Expert | Load any of the 15 skills from `../skills/<name>/SKILL.md` (and supporting files) by name. |
| `push_visual_screen` | Subordinate, Coordinator | Write an HTML fragment to `sessions/<id>/screens/<filename>.html` and push a live reload to the session's Visual Companion tab. |
| `read_visual_events` | Subordinate, Coordinator | Read recent click/selection events from `sessions/<id>/events.jsonl`. |
| `propose_rules` | Subordinate (`interview`/`ready`) | Save structured `rulesMarkdown` and `planMarkdown` for user review & approval. |
| `relay_to_coordinator` | Subordinate (after approval) | Relay new or updated instructions to the Coordinator (starts/resumes Coordinator if idle/paused, or queues at next turn boundary if running). |
| `get_coordinator_status` | Subordinate (after approval) | Read Coordinator phase, recent milestones, and active/completed Experts to report live progress to the human. |
| `pause_coordinator` / `resume_coordinator` | Subordinate (after approval) | Pause or resume Coordinator execution on the human's request. |
| `write_file` | Coordinator, writable Expert | Create or overwrite a file inside `effectiveWorkDir` (creates parent dirs). |
| `edit_file` | Coordinator, writable Expert | Exact search-and-replace edit on an existing file inside `effectiveWorkDir`. |
| `run_command` | Coordinator, writable Expert | Execute a shell command with `cwd: effectiveWorkDir`, timeout (default 120s), abort-signal kill (Windows `taskkill /T /F` / POSIX process group kill), and 32KB output cap. **Windows shell (Designer's call):** auto-detects Git Bash (`C:\Program Files\Git\bin\bash.exe` or per-user Git install, matching `hooks/run-hook.cmd`) so POSIX commands, `&&` chaining, and upstream `skills/*/scripts/` work seamlessly; falls back to PowerShell if Git Bash is absent, with a configurable `shell` override in Studio settings. |
| `spawn_expert` | Coordinator (and depth-1 Expert) | Spawn a specialist Expert/Subagent with `{ role, specialty?, task, context?, providerId?, model?, readOnly? }`. Multiple `spawn_expert` calls in a single turn execute **concurrently** (`Promise.all`) so parallel expert workflows work natively. |
| `escalate_to_subordinate` | Coordinator | Pause Coordinator cleanly and send a blocking question upward to the Subordinate, who relays it to the human. |
| `report_complete` | Coordinator | Signal verified task completion with `{ summary, verification }`, transitioning Coordinator & session to `completed` and prompting Subordinate to present the final report. |

### 5.6 Coordinator & Expert Engine (with Built-in + Custom Expert Roster)

- **Subordinate → Coordinator handoff:** When the user clicks **Approve & Dispatch to Coordinator**, Studio locks `rules` & `plan`, prepares workspace/worktree isolation, and launches the Coordinator loop with the mission brief, locked rules, plan, pinned skills, and the full **Expert Roster**.
- **Built-in Expert Roster** (persisted & customizable in `.superpowers-studio/experts.json`, with UI CRUD to edit personas, assign per-expert preferred provider/model, or add new experts):
  - **Medical & Imaging Domain Experts:**
    1. `senior-dicom-engineer` — **Senior DICOM Engineer** (DICOM PS3.x, IODs/SOP classes, VR/tag encoding, Transfer Syntaxes, DIMSE & DICOMweb WADO-RS/STOW-RS/QIDO-RS, pixel data/windowing, PS3.15 de-identification, PACS/Orthanc/dcm4chee/pydicom/Cornerstone).
    2. `hl7-fhir-engineer` — **HL7/FHIR Engineer** (HL7 v2.x ADT/ORM/ORU/SIU, MLLP/ACK, HL7 CDA, FHIR R4/R4B/R5 ImagingStudy/DiagnosticReport/Observation/Patient/ServiceRequest, SMART on FHIR, IHE profiles, LOINC/SNOMED CT/ICD-10/RadLex).
    3. `anatomical-illustrator` — **Anatomical Illustrator** (medically accurate SVG/HTML anatomical illustrations & schematics, axial/sagittal/coronal planes, radiological vs anatomical orientation conventions, clear structural callouts, color-blind-safe palettes; granted `push_visual_screen` to render live diagrams into the Visual Companion).
    4. `human-physiology-expert` — **Human Physiology Expert** (organ-system physiology, hemodynamics, neuro/respiratory/renal/endocrine/musculoskeletal mechanisms, clinical reference ranges, pathophysiology validation, and verifying biological accuracy of designs, simulations, and diagrams).
  - **Core Engineering Experts:**
    5. `implementer` — **Software Implementer** (TDD, clean implementation, tests).
    6. `code-reviewer` — **Code Reviewer** (spec compliance, security, code quality; read-only by default).
    7. `debugger` — **Systematic Debugger** (root-cause tracing, reproduction tests, minimal fixes).
    8. `researcher` — **Technical Researcher** (read-only codebase exploration & technical synthesis).
- **Coordinator → Expert delegation:** Coordinator calls `spawn_expert({ expertId?, role?, specialty?, task, context?, providerId?, model?, readOnly? })`. When `expertId` matches a roster profile, Studio automatically loads that expert's system persona, default `readOnly`/visual permissions, and preferred provider/model (if configured). Every Expert inherits the session's **locked Rules** automatically.
- **Per-tier & per-expert model routing:**
  - **Subordinate:** session's `providerId` / `model`.
  - **Coordinator:** session's `coordinatorProviderId` / `coordinatorModel` (falls back to Subordinate's).
  - **Expert:** explicit `providerId`/`model` on `spawn_expert` → else roster profile's `providerId`/`model` → else session's `expertProviderId`/`expertModel` → else Coordinator's.
- **Nesting & caps:** Max Expert nesting depth `2` (Coordinator → Expert → optional helper); default Coordinator cap `100` turns, Expert cap `40` turns; pausing/stopping the session immediately propagates `AbortSignal` to Coordinator, all running Experts, and their shell processes.
- **Live observability:** Coordinator and Expert events (`coordinator_delta`, `coordinator_tool_call`, `coordinator_tool_result`, `coordinator_status`, `expert_event`) stream over WebSocket to the dashboard in real time.

### 5.7 Web Dashboard UI & Embedded Visual Companion

3-pane layout styled with the same clean OS-aware light/dark design tokens as `skills/brainstorming/scripts/frame-template.html`:

- **Left Sidebar (Sessions & Config):**
  - `+ New Session` button (modal: task title, workspace folder path, Subordinate provider/model, optional Coordinator model override, optional Expert default model override).
  - Live session list with phase badge (`Interview`, `Ready`, `Running`, `Paused`, `Done`, `Failed`), Coordinator & active Expert count badge, and delete action.
  - `Providers & Models` button opening the provider settings modal (presets, custom OpenAI-compatible URL/headers, API key input, `toolMode` selector, `Fetch Models`, `Test Connection`).
- **Center Pane (Subordinate Chat & Controls):**
  - Top bar: session title, workspace/worktree badge, tier model pills (Subordinate / Coordinator / Experts), phase pill, and primary action controls (`Approve & Dispatch`, `Pause`, `Resume`, `Stop`, `Re-open Interview`).
  - Live **Coordinator Status Bar:** compact live strip showing Coordinator state (`Idle` / `Running — Turn N` / `Paused` / `Completed`) + count of active Experts, clickable to jump to the Coordinator tab.
  - Collapsible **Rules & Plan** drawer: shows the drafted/locked rules & plan side-by-side; editable before approval.
  - Streaming **Subordinate** timeline: your conversation with the Subordinate (markdown-rendered, collapsible reasoning, expandable read/relay tool cards, and upward reports/escalations from Coordinator).
  - Bottom composer: always active—chat with the Subordinate during interview, ask for live progress updates, or give mid-run instructions for Subordinate to relay to the Coordinator (with `/skill-name` autocomplete & companion selection badge).
- **Right Pane (Tabbed Inspector):**
  - **Coordinator & Experts tab:** Live hierarchical view showing the **Coordinator** card at top (status, model, relayed directives, full live streaming transcript & tool trace) and all spawned **Experts / Subagents** nested underneath (role, specialty, model pill, status, click any Expert to inspect its full transcript & tool calls).
  - **Visual Companion tab:** Embedded **sandboxed** iframe (`sandbox="allow-scripts"`, intentionally omitting `allow-same-origin`) serving `/api/sessions/:id/companion` with `Content-Security-Policy: frame-ancestors 'self'`. Because companion screens are LLM-generated HTML using inline `onclick="toggleSelect(this)"`, omitting `allow-same-origin` gives the iframe an opaque `null` origin so prompt-injected HTML cannot use the Studio auth cookie to call `/api/sessions/:id/approve` or execute shell commands. Instead, the companion helper script forwards click/selection events to the parent window via `window.parent.postMessage({ type: 'superpowers-companion-event', sessionId, event }, window.location.origin)` (or `*` from opaque origin, validated by `app.js` against `iframe.contentWindow`), and `app.js` persists them via authenticated `POST /api/sessions/:id/companion/events` and displays a selection badge in the composer.
  - **Skills tab:** Live catalog of **all 15 Superpowers skills** discovered from `../skills/*/SKILL.md` (`brainstorming`, `diagnosing-superpowers`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills`). Displays each skill's description, lets the user inspect its full `SKILL.md` and supporting files, pin/unpin skills into the current session's active context, or click **"Use in Chat"** (and supports `/skill-name` shortcuts in the composer). The runtime also injects the full 15-skill index (name + description) into every session's bootstrap prompt so models auto-invoke any relevant skill via `load_skill`.
  - **Workspace tab:** On-demand `git status` / changed-files summary and worktree branch details for the session.

### 5.8 HTTP & WebSocket API Contract

- **Auth:** Server generates a 32-byte random token on startup, prints `http://localhost:49500/?token=<token>`, sets `HttpOnly; SameSite=Strict` cookie on first load, and validates cookie/header + `Origin` on all `/api/*` and `/ws` requests. `/api/sessions/:id/companion` validates the auth cookie (or query token) to serve the screen HTML and sets `Content-Security-Policy: frame-ancestors 'self'`.
- **REST Endpoints:**
  - `GET /api/providers`, `PUT /api/providers/:id`, `POST /api/providers`, `DELETE /api/providers/:id`
  - `POST /api/providers/:id/test`, `GET /api/providers/:id/models`
  - `GET /api/experts`, `POST /api/experts`, `PUT /api/experts/:id`, `DELETE /api/experts/:id` (built-in + custom Expert Roster)
  - `GET /api/skills` (lists live skills from `../skills/`)
  - `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id`, `DELETE /api/sessions/:id` (`?force=true` required if an auto-created worktree has uncommitted changes; returns `409` otherwise)
  - `POST /api/sessions/:id/messages` (send interview message, mid-run queued steer, or reopen terminal session)
  - `POST /api/sessions/:id/approve` (lock rules/plan & transition to `running`)
  - `POST /api/sessions/:id/reopen-interview` (return to read-only `interview` phase to edit/re-approve rules & plan)
  - `POST /api/sessions/:id/pause`, `POST /api/sessions/:id/resume`, `POST /api/sessions/:id/stop`
  - `GET /api/sessions/:id/coordinator` (full Coordinator state, directives, and transcript)
  - `GET /api/sessions/:id/experts/:expertId` (full Expert/Subagent transcript & tool trace)
  - `GET /api/sessions/:id/workspace/status`
  - `GET /api/sessions/:id/companion`, `POST /api/sessions/:id/companion/events`
- **WebSocket (`/ws`):** Broadcasts typed JSON events scoped by `sessionId` (`session_updated`, `message_delta`, `reasoning_delta`, `tool_call`, `tool_result`, `coordinator_event`, `expert_event`, `companion_reload`, `error`).

---

## 6. Calls Made by the Designer (Confirm While Reviewing)

- **Location & isolation:** Put Studio in `studio/` and data in `.superpowers-studio/` (gitignored) so upstream `obra/superpowers` files and tests remain untouched.
- **Default port & localhost security:** Bind `127.0.0.1:49500` with a startup token cookie (same security pattern as `skills/brainstorming/scripts/server.cjs`).
- **Sandboxed Visual Companion iframe:** Render LLM-generated companion screens in `sandbox="allow-scripts"` (without `allow-same-origin`) and bridge clicks via `postMessage` → `app.js` → `/companion/events`, preventing untrusted HTML from bypassing the approval gate.
- **Autonomous loop & steering rules:** Add `ask_user` for intentional blocking questions; auto-nudge up to 2 times on text-only turns before pausing; queue mid-run user messages at the next turn boundary (preserving API tool-call pairing); allow follow-up messages on terminal sessions to resume under locked rules (with a separate "Re-open Interview" button).
- **Context-window management:** Keep lossless `messages.jsonl` on disk while pinning system prompt + locked rules/plan and trimming older large tool results automatically when approaching context limits or on overflow errors.
- **Restart & worktree safety:** Reconcile previously `running` sessions to `paused` on server restart; keep worktrees and `superpowers/<sessionId>` branches on completion; on delete, keep the branch and block dirty worktree removal unless force-confirmed.
- **Windows shell:** Default `run_command` to Git Bash on Windows when installed (so POSIX commands, `&&`, and `skills/*/scripts/` work cleanly), with PowerShell fallback and a configurable override.
- **Safety limits:** Default `maxTurns: 100` per autonomous run, `40` turns per subagent, max subagent depth `2`, 120s default command timeout, and 5-strike identical-error circuit breaker.
- **Tool-calling fallback:** `toolMode: "auto"` on Abliteration.ai, OpenRouter, and Ollama so models without native function-calling support automatically fall back to `<tool_call>` prompt parsing.
- **Subagent concurrency:** Multiple `spawn_subagent` tool calls emitted in the same assistant turn run in parallel automatically.

## 7. Left to the Builder

- Exact Markdown renderer subset (safe HTML escaping + headings, lists, bold/italic, inline/fenced code blocks).
- Exponential backoff / retry timing for HTTP 429 / 5xx provider responses.
- Exact UI CSS styling polish, responsive breakpoints, and keyboard shortcuts.
- Unit and integration test suite structure under `studio/tests/` (using Node's built-in `node --test` runner with mocked HTTP provider servers).
