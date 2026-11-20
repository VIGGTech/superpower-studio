# Superpowers Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Superpowers Studio (`studio/`), a standalone, zero-dependency Node.js multi-provider autonomous agent environment with a 3-tier **Subordinate → Coordinator → Experts** hierarchy, a local web dashboard, live integration of all 15 Superpowers skills, parallel sessions with automatic git worktree isolation, and an embedded sandboxed Visual Companion.

**Architecture:** A self-contained Node.js ESM server (`studio/server.mjs`) backed by persistent local JSON/JSONL storage (`.superpowers-studio/`), three native HTTP streaming provider adapters (OpenAI-compatible with `<tool_call>` prompt fallback, Anthropic Messages, and Google Gemini), a workspace-scoped tool & git-worktree executor, an async 3-tier multi-session orchestrator (**Subordinate** handles human chat, interview, rules, and relaying instructions; **Coordinator** autonomously executes plans and dispatches **Experts/Subagents** in parallel or sequence; upward reports flow back through Subordinate), and a zero-build 3-pane web dashboard over HTTP + zero-dep RFC 6455 WebSocket. Upstream `obra/superpowers` directories (`skills/`, `hooks/`, `tests/`) remain completely untouched and `skills/` is read live.

**Tech Stack:** Node.js 20.19+ (ESM, built-in `http`, `fs`, `path`, `crypto`, `child_process`, `fetch`, `node:test`), vanilla HTML/CSS/ES-module JavaScript frontend, zero external runtime npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-superpowers-studio-design.md`

## Global Constraints

- Node.js `v20.19+`, zero runtime npm dependencies, zero frontend build step.
- All Studio code lives in `studio/`; all runtime state lives in `.superpowers-studio/` (gitignored, overrideable via `SUPERPOWERS_STUDIO_DATA_DIR`).
- Upstream `obra/superpowers` `skills/`, `hooks/`, and `tests/` must remain unmodified and existing tests must keep passing.
- Default bind `127.0.0.1:49500` with startup 32-byte token (`?token=...` → `HttpOnly; SameSite=Strict` cookie) + strict `Origin` verification on all `/api/*` and `/ws` requests.
- Visual Companion iframe uses `sandbox="allow-scripts"` (NO `allow-same-origin`) with `Content-Security-Policy: frame-ancestors 'self'` and bridges click events via `postMessage` → `app.js` → `POST /api/sessions/:id/companion/events`.
- All 15 live skills from `../skills/*/SKILL.md` are indexed in bootstrap prompts, loadable via `load_skill`, browsable/pinnable in the UI Skills tab, and invocable via `/skill-name` shortcuts.
- Windows `run_command` auto-detects Git Bash (`C:\Program Files\Git\bin\bash.exe` or per-user Git install) and falls back to PowerShell.

## Review Focus

1. **Prompt-injected `<script>` in a Visual Companion screen trying to call `POST /api/sessions/:id/approve`** — `/api/sessions/:id/companion` must set `frame-ancestors 'self'`, the dashboard iframe must omit `allow-same-origin`, and `Origin: null` requests to `/api/*` must be rejected with `403` (pinned in Task 6 tests).
2. **Open/abliterated model on Abliteration.ai rejecting native `tools` (HTTP 400/422) or wrapping `<tool_call>` inside Markdown fences** — `openai-compat` with `toolMode: "auto"` must retry transparently in prompt mode and parse fenced `<tool_call>` blocks cleanly (pinned in Task 3 tests).
3. **Two simultaneous sessions approved on the same Git repository, or deleting a session with uncommitted changes in its auto-worktree** — second session must receive an isolated `superpowers/<sessionId>` worktree; `DELETE` without `force=true` must return `409` on dirty worktrees and always preserve the git branch (pinned in Task 4 & Task 6 tests).
4. **Mid-run user message arriving while an assistant turn or tool call is in flight** — message must queue and inject at the next turn boundary without breaking assistant-tool_call / tool_result ordering (pinned in Task 5 tests).
5. **Path traversal (`../..` or absolute outside path) in file tools and server restart while sessions are persisted as `running`** — file tools must reject any path outside `effectiveWorkDir`, and startup reconciliation must reset persisted `running` sessions to `paused` and orphaned subagents to `stopped` (pinned in Task 1 & Task 4 tests).

---

### Task 1: Store (`store.mjs`), Live 15-Skill Loader (`skills.mjs`), and `.gitignore`

**Files:**
- Modify: `.gitignore` (append `.superpowers-studio/`)
- Create: `studio/package.json` (`{ "name": "superpowers-studio", "type": "module", "private": true, "scripts": { "start": "node server.mjs", "test": "node --test tests/*.test.mjs" } }`)
- Create: `studio/lib/store.mjs`
- Create: `studio/lib/skills.mjs`
- Test: `studio/tests/store-and-skills.test.mjs`

**Interfaces:**
- Consumes: `../skills/*/SKILL.md` (read-only)
- Produces:
  - `store.mjs`:
    - `createStore({ dataDir }) -> Store`
    - `store.getProviders() -> ProviderProfile[]` (raw, with resolved `effectiveApiKey`)
    - `store.getProvidersMasked() -> MaskedProviderProfile[]` (masks `apiKey`, adds `hasKey: boolean`, `keySource: "saved" | "env" | "none"`)
    - `store.upsertProvider(profile) -> ProviderProfile`, `store.deleteProvider(id) -> boolean`
    - `store.getExpertRoster() -> ExpertProfile[]` (seeded with 8 built-in experts: `senior-dicom-engineer`, `hl7-fhir-engineer`, `anatomical-illustrator`, `human-physiology-expert`, `implementer`, `code-reviewer`, `debugger`, `researcher`)
    - `store.upsertExpertProfile(profile) -> ExpertProfile`, `store.deleteExpertProfile(id) -> boolean`
    - `store.getSettings() -> { shell?: string }`, `store.updateSettings(patch)`
    - `store.listSessions() -> SessionSummary[]`
    - `store.createSession(input) -> Session`
    - `store.getSession(id) -> Session | null`
    - `store.updateSession(id, patch) -> Session`
    - `store.deleteSession(id) -> boolean`
    - `store.appendMessage(sessionId, msg) -> void`, `store.getMessages(sessionId) -> Message[]`
    - `store.getCoordinator(sessionId) -> CoordinatorState`, `store.saveCoordinator(sessionId, coord) -> void`
    - `store.saveExpert(sessionId, expert) -> void`, `store.getExpert(sessionId, expertId) -> Expert | null`, `store.listExperts(sessionId) -> Expert[]`
    - `store.writeScreen(sessionId, filename, html) -> string`, `store.getLatestScreen(sessionId) -> { filename, html } | null`
    - `store.appendCompanionEvent(sessionId, event) -> void`, `store.getCompanionEvents(sessionId, limit?) -> Event[]`
    - `store.reconcileOnStartup() -> { pausedSessions: string[], stoppedExperts: string[] }`
  - `skills.mjs`:
    - `loadSkillCatalog(skillsRoot) -> SkillSummary[]` (`{ name, description, dir, skillFile, files }`)
    - `readSkill(skillsRoot, name, relativeFile?) -> { name, description, content, files } | null`
    - `buildBootstrapPrompt({ skillsRoot, tier, phase, rules, plan, pinnedSkills, shellName, effectiveWorkDir, extraContext? }) -> string` (`tier: "subordinate" | "coordinator" | "expert"`)

- [ ] **Step 1: Write failing tests in `studio/tests/store-and-skills.test.mjs`**
  Assert:
  - `loadSkillCatalog` discovers all 15 skills under `skills/` (including `brainstorming`, `systematic-debugging`, `test-driven-development`, `writing-plans`, `subagent-driven-development`, `using-superpowers`, `verification-before-completion`, etc.), parses YAML frontmatter `name` and `description`, and `readSkill` loads `SKILL.md` and rejects `..` relative file escapes.
  - `buildBootstrapPrompt` includes `using-superpowers` content, lists all 15 skill names + descriptions, embeds `pinnedSkills` bodies, reflects `phase` (`interview` vs `running`), and pins locked `rules`/`plan`.
  - `createStore` seeds all 7 built-in provider presets (Anthropic, Google Gemini, DeepSeek, Qwen, Abliteration.ai at `https://api.abliteration.ai/v1` with `toolMode: "auto"`, OpenRouter, Ollama), resolves `ABLIT_KEY`/`ABLITERATION_API_KEY` env fallback, and `getProvidersMasked()` never exposes raw keys.
  - Session CRUD, `appendMessage`/`getMessages`, `writeScreen`/`getLatestScreen`, `appendCompanionEvent`/`getCompanionEvents` persist across fresh `createStore` instances.
  - `reconcileOnStartup()` flips persisted `running` sessions to `paused` (appending a restart notice) and orphaned `running` subagents to `stopped`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test studio/tests/store-and-skills.test.mjs`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Add `.superpowers-studio/` to `.gitignore`, create `studio/package.json`, and implement `studio/lib/skills.mjs` and `studio/lib/store.mjs`**
  - Keep `store.mjs` synchronous-safe on JSON metadata writes (atomic write via `.tmp` + `renameSync`) and append-only on `.jsonl` files.
  - Set `0o600` file mode on `providers.json` on POSIX (no-op on Windows).

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test studio/tests/store-and-skills.test.mjs`
  Expected: PASS (all assertions pass).

- [ ] **Step 5: Commit**
  ```bash
  git add .gitignore studio/package.json studio/lib/store.mjs studio/lib/skills.mjs studio/tests/store-and-skills.test.mjs
  git commit -m "feat(studio): add persistent store and live 15-skill loader"
  ```

---

### Task 2: Zero-Dependency RFC 6455 WebSocket Server (`studio/lib/ws.mjs`)

**Files:**
- Create: `studio/lib/ws.mjs`
- Test: `studio/tests/ws.test.mjs`

**Interfaces:**
- Consumes: Node built-ins (`crypto`, `events`)
- Produces:
  - `createWebSocketServer({ validateUpgrade }) -> WsServer`
    - `wsServer.attach(httpServer, pathname)`
    - `wsServer.broadcast(payload)` (JSON-serializes and sends to all open clients)
    - `wsServer.sendTo(client, payload)`
    - `wsServer.close()`
    - Events: `connection(client, req)`, `message(client, data)`, `close(client)`
  - Pure exports for unit tests: `computeAcceptKey`, `encodeFrame`, `decodeFrame`, `OPCODES`

- [ ] **Step 1: Write failing tests in `studio/tests/ws.test.mjs`**
  Assert:
  - `encodeFrame`/`decodeFrame` round-trip small (<126B), medium (126–65535B), and large (>65535B) payloads; rejects unmasked client frames and oversized (>10MB) 64-bit frames.
  - Live `http.createServer` + `wsServer.attach(server, '/ws')`: rejects upgrades when `validateUpgrade` returns `false` (HTTP 403), accepts valid upgrades, broadcasts JSON messages to connected clients, and handles ping/pong + close frames cleanly.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test studio/tests/ws.test.mjs`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `studio/lib/ws.mjs`**
  Follow the RFC 6455 framing structure proven in `skills/brainstorming/scripts/server.cjs`, adding multi-frame buffer draining, fragmented/continuation frame handling, and graceful socket cleanup.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test studio/tests/ws.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add studio/lib/ws.mjs studio/tests/ws.test.mjs
  git commit -m "feat(studio): add zero-dependency RFC 6455 WebSocket server"
  ```

---

### Task 3: Multi-Provider Streaming Adapters & Prompt-Tool Fallback (`studio/lib/providers/`)

**Files:**
- Create: `studio/lib/providers/prompt-tools.mjs`
- Create: `studio/lib/providers/openai-compat.mjs`
- Create: `studio/lib/providers/anthropic.mjs`
- Create: `studio/lib/providers/gemini.mjs`
- Create: `studio/lib/providers/index.mjs`
- Test: `studio/tests/providers.test.mjs`

**Interfaces:**
- Consumes: `ProviderProfile` shape from Task 1, Node built-in `fetch`
- Produces:
  - `prompt-tools.mjs`:
    - `buildPromptToolsInstructions(tools) -> string`
    - `formatPromptToolResult(toolCallId, name, resultText) -> string`
    - `parsePromptToolCalls(text) -> { cleanText: string, toolCalls: Array<{ id, name, arguments }> }`
  - `providers/index.mjs`:
    - `streamChat({ provider, model, systemPrompt, messages, tools, signal, onText, onReasoning }) -> Promise<{ content, reasoning, toolCalls, usage, stopReason }>`
    - `listProviderModels(provider) -> Promise<string[]>`
    - `testProviderConnection(provider, model?) -> Promise<{ ok: boolean, latencyMs: number, message: string, modelsCount?: number }>`
    - Normalized error fields: `err.status`, `err.isContextOverflow`, `err.isToolsUnsupported`, `err.retryable`.

- [ ] **Step 1: Write failing tests in `studio/tests/providers.test.mjs`**
  Spin up local mock HTTP servers (`http.createServer` on port `0`) and assert:
  - `prompt-tools`: parses single and multiple `<tool_call>` blocks, handles `<tool_call>` wrapped inside Markdown code fences, ignores malformed JSON gracefully, strips tags from `cleanText`.
  - `openai-compat`: streams SSE `content` + `reasoning_content` + incremental `tool_calls` (including DeepSeek/Qwen/Abliteration.ai shapes); when `toolMode: "auto"` hits HTTP 400 `"tools are not supported"`, retries automatically in prompt-tool mode and caches fallback for `(provider.id, model)`; `listProviderModels` parses `GET /models`.
  - `anthropic`: sends `x-api-key` + `anthropic-version: 2023-06-01`, streams `text_delta`, `thinking_delta`, and `tool_use` `input_json_delta` blocks into normalized `{ content, reasoning, toolCalls }`.
  - `gemini`: sends `x-goog-api-key`, maps tools to `functionDeclarations`, streams SSE `text`, `thought`, and `functionCall` parts into normalized result.
  - Retry & error normalization: retries transient HTTP 429/503 once/twice with short test backoff; marks context-length 400 responses with `err.isContextOverflow === true`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test studio/tests/providers.test.mjs`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `prompt-tools.mjs`, `openai-compat.mjs`, `anthropic.mjs`, `gemini.mjs`, and `index.mjs`**
  - Keep internal message format provider-neutral (`{ role: "user" | "assistant" | "tool", content, reasoning?, toolCalls?, toolCallId?, toolName? }`) and map cleanly in each adapter (pairing Anthropic `tool_result` blocks in user turns and Gemini `functionResponse` parts).
  - Respect `AbortSignal` on every `fetch` and SSE reader loop.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test studio/tests/providers.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add studio/lib/providers studio/tests/providers.test.mjs
  git commit -m "feat(studio): add Anthropic, Gemini, and OpenAI-compatible adapters with prompt-tool fallback"
  ```

---

### Task 4: Git Worktree Isolation (`worktree.mjs`) & Scoped Tool Executor (`tools.mjs`)

**Files:**
- Create: `studio/lib/worktree.mjs`
- Create: `studio/lib/tools.mjs`
- Test: `studio/tests/worktree-and-tools.test.mjs`

**Interfaces:**
- Consumes: `store`, `skills` (`readSkill`)
- Produces:
  - `worktree.mjs`:
    - `detectGitRoot(dir) -> Promise<string | null>`
    - `prepareSessionWorkspace({ session, activeSessions, dataDir }) -> Promise<{ effectiveWorkDir: string, worktreeBranch: string | null, warning: string | null }>`
    - `getWorkspaceStatus(dir) -> Promise<{ isGit: boolean, branch: string | null, changedFiles: Array<{ status, path }> }>`
    - `cleanupSessionWorktree({ session, force }) -> Promise<{ removed: boolean, dirtyFiles?: string[] }>`
  - `tools.mjs`:
    - `detectDefaultShell(override?) -> { executable: string, argsPrefix: string[], displayName: string }`
    - `getToolDefinitions({ tier, phase, readOnly, depth }) -> ToolSchema[]` (`tier: "subordinate" | "coordinator" | "expert"`)
      - `subordinate` (`interview`/`ready`): `read_file`, `list_files`, `search_files`, `load_skill`, `push_visual_screen`, `read_visual_events`, `propose_rules`
      - `subordinate` (after approval): read/inspect/skills/visual + `relay_to_coordinator`, `get_coordinator_status`, `pause_coordinator`, `resume_coordinator` (NEVER mutating file/shell tools!)
      - `coordinator`: full read/write/edit/shell/skills/visual + `spawn_expert`, `escalate_to_subordinate`, `report_complete`
      - `expert`: read/inspect/skills (+ `write_file`/`edit_file`/`run_command` if `!readOnly`, + `spawn_expert` if `depth < 2`)
    - `createToolExecutor({ store, skillsRoot, session, effectiveWorkDir, signal, shellOverride, callbacks }) -> { execute(name, args) -> Promise<{ ok: boolean, output: string }> }`

- [ ] **Step 1: Write failing tests in `studio/tests/worktree-and-tools.test.mjs`**
  Create temp git repos and assert:
  - `prepareSessionWorkspace`: first session uses primary repo; second concurrent session on same git repo creates `<dataDir>/worktrees/<sessionId>` on branch `superpowers/<sessionId>` with isolated files; non-git conflict returns `warning`.
  - `cleanupSessionWorktree`: removes clean worktree while keeping `superpowers/<sessionId>` branch; refuses dirty worktree (`removed: false, dirtyFiles: [...]`) unless `force: true`.
  - `tools.mjs` path scoping: `read_file`, `write_file`, `edit_file`, `list_files`, `search_files` work inside `effectiveWorkDir` and reject `../outside.txt` or absolute paths outside `effectiveWorkDir`.
  - `getToolDefinitions`: `subordinate` NEVER gets `write_file`/`edit_file`/`run_command`/`spawn_expert`; in `interview` it gets `propose_rules`, after approval it gets `relay_to_coordinator`/`get_coordinator_status`/`pause_coordinator`/`resume_coordinator`; `coordinator` gets full execution + `spawn_expert`/`escalate_to_subordinate`/`report_complete`; `readOnly` expert omits mutating tools.
  - `run_command`: executes commands in `effectiveWorkDir`, truncates output >32KB, and kills long-running child processes promptly when `AbortSignal` fires (verified on Windows!).
  - `load_skill` loads real skills from `skills/` (e.g. `test-driven-development`).

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test studio/tests/worktree-and-tools.test.mjs`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `studio/lib/worktree.mjs` and `studio/lib/tools.mjs`**
  - Windows shell detection checks `C:\Program Files\Git\bin\bash.exe`, `C:\Program Files\Git\usr\bin\bash.exe`, and `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` before falling back to PowerShell.
  - Windows abort cleanup runs `taskkill /PID <pid> /T /F` (ignoring already-exited errors) so child process trees terminate cleanly.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test studio/tests/worktree-and-tools.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add studio/lib/worktree.mjs studio/lib/tools.mjs studio/tests/worktree-and-tools.test.mjs
  git commit -m "feat(studio): add git worktree isolation and tier-scoped tool executor"
  ```

---

### Task 5: 3-Tier Multi-Session Orchestrator (`studio/lib/orchestrator.mjs`)

**Files:**
- Create: `studio/lib/orchestrator.mjs`
- Test: `studio/tests/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `store`, `skills`, `providers.streamChat`, `worktree`, `tools`
- Produces:
  - `createOrchestrator({ store, skillsRoot, streamChatImpl?, emitEvent }) -> Orchestrator`
    - `orchestrator.sendUserMessage(sessionId, text) -> Promise<Session>` (always handled by **Subordinate**, even while Coordinator runs in background! Expands `/skill-name` shortcuts; Subordinate can answer status via `get_coordinator_status`, queue course corrections via `relay_to_coordinator`, or pause/resume Coordinator)
    - `orchestrator.approveAndRun(sessionId, { rules?, plan?, allowSharedNonGit? }) -> Promise<Session>` (locks rules/plan, runs worktree isolation, dispatches mission from Subordinate → **Coordinator** in background)
    - `orchestrator.reopenInterview(sessionId) -> Promise<Session>`
    - `orchestrator.pauseSession(sessionId) -> Promise<Session>`
    - `orchestrator.resumeSession(sessionId) -> Promise<Session>`
    - `orchestrator.stopSession(sessionId) -> Promise<Session>`
    - `orchestrator.setPinnedSkills(sessionId, skillNames) -> Session`
    - `orchestrator.buildPromptWindow(messages, { maxChars }) -> Message[]` (exported helper for testing context trimming)

- [ ] **Step 1: Write failing tests in `studio/tests/orchestrator.test.mjs`**
  Use an injected deterministic fake `streamChatImpl` and assert:
  - **3-tier Subordinate → Coordinator → Experts flow:** in `interview`, Subordinate drafts rules via `propose_rules` (moving to `ready`); `approveAndRun` dispatches mission to **Coordinator**, which spawns two **Experts** in parallel (`Promise.all`), each inheriting locked `rules` and respecting tier/per-expert model overrides; Coordinator calls `report_complete`, which triggers a Subordinate summary back to the human and marks session `completed`.
  - **Live Subordinate chat & mid-run relay:** while Coordinator is actively executing a slow tool/expert, user sends a message → **Subordinate** replies immediately, calls `get_coordinator_status` + `relay_to_coordinator`, and the relayed directive is delivered cleanly to Coordinator at its next turn boundary without breaking tool_call/tool_result ordering.
  - **Coordinator escalation & text-only nudging:** `escalate_to_subordinate` pauses Coordinator and triggers a Subordinate message asking the human; 2 text-only Coordinator turns auto-nudge and a 3rd pauses cleanly.
  - **Parallel sessions, context trimming, slash-skills & circuit breaker:** two sessions run concurrently without blocking each other; `buildPromptWindow` trims older large tool outputs + single overflow retry; `/systematic-debugging` injects the skill; 5 identical failing tool calls pause Coordinator; `stopSession` aborts Coordinator and all active Experts.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test studio/tests/orchestrator.test.mjs`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `studio/lib/orchestrator.mjs`**
  Keep per-session runtime state (`coordinatorAbort`, `directiveQueue`, `pauseRequested`, `activeExperts`, `subordinateBusy`) in an in-memory `Map<sessionId, Runtime>` cleanly decoupled from persisted `store` state so Subordinate and Coordinator run asynchronously without blocking each other.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test studio/tests/orchestrator.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add studio/lib/orchestrator.mjs studio/tests/orchestrator.test.mjs
  git commit -m "feat(studio): add 3-tier Subordinate-Coordinator-Experts orchestrator"
  ```

---

### Task 6: HTTP + WebSocket Server & Sandboxed Visual Companion (`studio/server.mjs`)

**Files:**
- Create: `studio/server.mjs`
- Test: `studio/tests/server.test.mjs`

**Interfaces:**
- Consumes: `store`, `skills`, `ws`, `providers`, `worktree`, `orchestrator`
- Produces:
  - `createStudioServer({ dataDir, skillsRoot, port, host, token?, streamChatImpl? }) -> Promise<{ server, port, host, token, url, close() }>`
  - CLI entrypoint when executed directly (`node studio/server.mjs [--port 49500] [--host 127.0.0.1] [--no-open]`), printing startup JSON + ready URL with `?token=...`.

- [ ] **Step 1: Write failing tests in `studio/tests/server.test.mjs`**
  Assert:
  - **Auth & Origin security:** unauthenticated `GET /api/sessions` returns `401`/`403`; `GET /?token=<token>` sets `HttpOnly; SameSite=Strict` cookie and serves `index.html`; `POST /api/sessions/:id/approve` with `Origin: null` (simulated sandboxed iframe) or foreign `Origin: https://evil.example` is rejected with `403` even with a valid cookie.
  - **Visual Companion sandboxing:** `GET /api/sessions/:id/companion` returns `Content-Security-Policy: frame-ancestors 'self'`, wraps HTML fragments in the Superpowers frame template with a `postMessage` helper (`toggleSelect`), and `POST /api/sessions/:id/companion/events` records events into `events.jsonl`.
  - **Skills, Expert Roster & Providers API:** `GET /api/skills` returns all 15 skills; `GET /api/skills/test-driven-development` returns full markdown; `GET /api/experts` returns all 8 seeded expert profiles (including `senior-dicom-engineer`, `hl7-fhir-engineer`, `anatomical-illustrator`, `human-physiology-expert`) and supports `POST`/`PUT`/`DELETE /api/experts`; `GET /api/providers` returns masked keys; `PUT /api/providers/abliteration` saves updates; `PUT /api/sessions/:id/skills` updates pinned skills.
  - **Session, Coordinator & Experts API:** `POST /api/sessions`, `POST /api/sessions/:id/messages`, `POST /api/sessions/:id/approve`, `POST /api/sessions/:id/reopen-interview`, `POST /api/sessions/:id/pause`, `POST /api/sessions/:id/stop`, `GET /api/sessions/:id/coordinator`, `GET /api/sessions/:id/experts/:expertId`, and `DELETE /api/sessions/:id` (returning `409` on dirty worktree, `200` with `?force=true`).

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test studio/tests/server.test.mjs`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `studio/server.mjs`**
  - Call `store.reconcileOnStartup()` before listening.
  - Reuse the CSS theme & helper layout from `skills/brainstorming/scripts/frame-template.html` for `/api/sessions/:id/companion`, replacing direct fetch/WS event submission with `window.parent.postMessage({ type: 'superpowers-companion-event', sessionId, event }, '*')` so it works inside `sandbox="allow-scripts"`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node --test studio/tests/server.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add studio/server.mjs studio/tests/server.test.mjs
  git commit -m "feat(studio): add authenticated HTTP/WS server and sandboxed visual companion"
  ```

---

### Task 7: Web Dashboard UI (`studio/public/`) & End-to-End Verification

**Files:**
- Create: `studio/public/index.html`
- Create: `studio/public/styles.css`
- Create: `studio/public/app.js`
- Test: `studio/tests/e2e.test.mjs`

**Interfaces:**
- Consumes: All REST endpoints and `/ws` events from Task 6
- Produces: Complete 3-pane local web dashboard with:
  - Multi-session sidebar + `+ New Session` modal (title, workspace path, **Subordinate** provider/model, optional **Coordinator** provider/model override, optional **Experts** default provider/model override).
  - `Providers & Models` modal (all 7 presets + `+ Add Custom Provider`, base URL, API key, `toolMode` selector, `Fetch Models`, `Test Connection`) and `Expert Roster` modal (view/edit/add domain & engineering experts—seeded with Senior DICOM Engineer, HL7/FHIR Engineer, Anatomical Illustrator, Human Physiology Expert, Implementer, Code Reviewer, Debugger, Researcher—with per-expert system persona, permissions, and preferred provider/model override).
  - Center **Subordinate** view: header controls (`Approve & Dispatch`, `Pause`, `Resume`, `Stop`, `Re-open Interview`), live **Coordinator Status Banner**, editable **Rules & Plan** drawer, live streaming Subordinate chat (Markdown + collapsible reasoning + expandable read/relay tool cards + Coordinator upward reports), composer with `/skill-name` autocomplete & companion selection badge.
  - Right inspector with 4 tabs:
    1. **Coordinator & Experts** (visual hierarchy: Coordinator live status/directives/transcript at top + spawned Experts/Subagents nested underneath, click any node to inspect its full streaming transcript & tool trace)
    2. **Visual Companion** (`<iframe sandbox="allow-scripts">` — NO `allow-same-origin` — + `window.addEventListener('message', ...)` verifying `e.source === iframe.contentWindow` and posting to `/api/sessions/:id/companion/events`)
    3. **Skills** (all 15 live Superpowers skills with search filter, full Markdown viewer, per-session **Pin/Unpin** toggle, and **"Use in Chat"** button)
    4. **Workspace** (git branch, worktree indicator, modified files list with Refresh)

- [ ] **Step 1: Write failing end-to-end test in `studio/tests/e2e.test.mjs`**
  Spin up a real Studio server + local mock OpenAI-compatible provider server (simulating Abliteration.ai with SSE streaming + tool calls + reasoning) and assert:
  - `GET /?token=...` serves `index.html` containing `<iframe` with `sandbox="allow-scripts"` and WITHOUT `allow-same-origin`; `GET /styles.css` and `GET /app.js` return `200`.
  - Full 3-tier live workflow over HTTP + WebSocket: configure provider pointing at mock server → `GET /api/providers/:id/models` → create session → interview **Subordinate** (pushes visual screen + proposes rules) → companion click posted → approve & dispatch → **Coordinator** spawns an **Expert** that writes a real file inside temp workspace → Coordinator calls `report_complete` → **Subordinate** posts final summary → WebSocket receives streaming deltas, `coordinator_event`, `expert_event`, `companion_reload`, and final `completed` status → file exists on disk!

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test studio/tests/e2e.test.mjs`
  Expected: FAIL (missing `studio/public/*`).

- [ ] **Step 3: Implement `studio/public/index.html`, `studio/public/styles.css`, and `studio/public/app.js`**
  - Ensure all user/model content rendered into DOM uses safe HTML escaping (never raw `innerHTML` on untrusted text without escaping).
  - Ensure WebSocket auto-reconnects with exponential backoff and re-fetches active session state on reconnect.

- [ ] **Step 4: Run full Studio test suite AND verify upstream `obra/superpowers` tests still pass**
  Run:
  - `node --test studio/tests/*.test.mjs`
  - `Push-Location tests\brainstorm-server; npm test; Pop-Location`
  - `& "C:\Program Files\Git\bin\bash.exe" tests/skill-layout/test-no-dev-files-in-skills.sh`
  - `& "C:\Program Files\Git\bin\bash.exe" tests/skill-size/test-skill-size.sh`
  Expected: ALL PASS with zero regressions.

- [ ] **Step 5: Commit**
  ```bash
  git add studio/public studio/tests/e2e.test.mjs
  git commit -m "feat(studio): add 3-pane web dashboard with all 15 skills and e2e tests"
  ```
