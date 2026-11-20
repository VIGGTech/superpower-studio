import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    toolMode: 'native',
    extraHeaders: {},
  },
  {
    id: 'gemini',
    name: 'Google (Gemini)',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-pro',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    toolMode: 'native',
    extraHeaders: {},
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    toolMode: 'native',
    extraHeaders: {},
  },
  {
    id: 'qwen',
    name: 'Qwen (DashScope)',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    envVar: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
    models: ['qwen-max', 'qwen-plus', 'qwen3-coder-plus', 'qwq-plus'],
    toolMode: 'native',
    extraHeaders: {},
  },
  {
    id: 'abliteration',
    name: 'Abliteration.ai',
    kind: 'openai-compatible',
    baseUrl: 'https://api.abliteration.ai/v1',
    apiKey: '',
    envVar: 'ABLIT_KEY',
    envVarFallbacks: ['ABLITERATION_API_KEY'],
    defaultModel: 'abliterated-model',
    models: [
      'abliterated-model-large-flash',
      'abliterated-model',
      'abliterated-model-large-v2',
      'abliterated-model-large',
    ],
    toolMode: 'auto',
    extraHeaders: {},
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-sonnet-4',
    models: [],
    toolMode: 'auto',
    extraHeaders: {},
  },
  {
    id: 'ollama',
    name: 'Local Ollama',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    envVar: '',
    defaultModel: 'qwen2.5-coder:14b',
    models: [],
    toolMode: 'auto',
    extraHeaders: {},
  },
];

export const DEFAULT_EXPERTS = [
  {
    id: 'senior-dicom-engineer',
    name: 'Senior DICOM Engineer',
    category: 'Medical & Imaging',
    specialty: 'DICOM PS3.x, IODs/SOP classes, VR/tag encoding, Transfer Syntaxes, DIMSE & DICOMweb (WADO-RS/STOW-RS/QIDO-RS), pixel data/windowing, PS3.15 de-identification, PACS/Orthanc/dcm4chee/pydicom/Cornerstone.',
    readOnly: false,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: [],
    systemPrompt: `You are a Senior DICOM Engineer with deep mastery of the NEMA DICOM PS3.x standard.
- Verify SOP Class UIDs, Transfer Syntax UIDs, explicit/implicit VR encoding, private tag conventions, and character set handling (Specific Character Set 0008,0005).
- Handle pixel data pipelines rigorously: Photometric Interpretation, Bits Allocated/Stored/High Bit, Pixel Representation (signed vs unsigned), Rescale Slope/Intercept, VOI LUT / Window Center & Width, multi-frame functional groups, and compressed transfer syntaxes (JPEG 2000, HTJ2K, JPEG-LS, RLE).
- Apply DICOMweb (QIDO-RS, WADO-RS, STOW-RS, UPS-RS) and DIMSE (C-STORE, C-FIND, C-MOVE, C-GET, C-ECHO) best practices, plus PS3.15 Basic Application Level Confidentiality Profile for PHI de-identification.
- Validate conformance with automated tests and real byte-level or library verification.`,
  },
  {
    id: 'hl7-fhir-engineer',
    name: 'HL7/FHIR Engineer',
    category: 'Medical & Imaging',
    specialty: 'HL7 v2.x (ADT/ORM/ORU/SIU, MLLP/ACK), HL7 CDA, FHIR R4/R4B/R5 (ImagingStudy, DiagnosticReport, Observation, Patient, ServiceRequest), SMART on FHIR, IHE profiles, LOINC/SNOMED CT/ICD-10/RadLex.',
    readOnly: false,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: [],
    systemPrompt: `You are a Senior HL7 & FHIR Interoperability Engineer.
- Ensure strict schema and cardinality compliance for HL7 v2.x pipe-delimited messages (MSH/PID/PV1/ORC/OBR/OBX/NTE, escaping rules, MLLP framing, ACK/NAK handling) and FHIR R4/R4B/R5 JSON/XML resources (Patient, ImagingStudy, DiagnosticReport, Observation, ServiceRequest, Practitioner, Bundle, OperationOutcome).
- Preserve clinically accurate coding systems and URIs (LOINC, SNOMED CT, ICD-10-CM, RadLex, UCUM units, DICOM UIDs as urn:oid:...).
- Follow SMART on FHIR / OAuth2 scopes, US Core / IHE Radiology (SWF, XDS-I, MHD, WIA) integration profiles, and safe PHI handling.
- Validate all generated parsers, mappers, and FHIR payloads with deterministic tests.`,
  },
  {
    id: 'anatomical-illustrator',
    name: 'Anatomical Illustrator',
    category: 'Medical & Imaging',
    specialty: 'Medically accurate SVG/HTML anatomical illustrations & schematics, axial/sagittal/coronal planes, radiological vs anatomical orientation conventions, labeled structural callouts, color-blind-safe medical palettes.',
    readOnly: false,
    allowVisualCompanion: true,
    providerId: '',
    model: '',
    defaultSkills: [],
    systemPrompt: `You are a Certified Medical & Anatomical Illustrator specializing in clear, anatomically faithful digital schematics and SVG/HTML visualizations.
- Maintain strict anatomical orientation conventions and explicitly label view planes (Axial/Transverse, Sagittal, Coronal/Frontal) and convention (Radiological left-on-right vs Anatomical view, Superior/Inferior, Anterior/Posterior, Medial/Lateral).
- Produce crisp, scalable SVG or HTML/Canvas diagrams with unambiguous leader-line callouts, clean visual hierarchy, accessible contrast, and color-blind-safe medical palettes.
- You have access to \`push_visual_screen\` to present illustrations live in the Visual Companion, \`view_workspace_image\` to visually inspect rendered PNGs/SVGs before approving them, and file tools to save SVG/HTML/component assets in the workspace.
- Never claim an illustration looks right without rendering it to PNG and inspecting it with \`view_workspace_image\`. Double-check spatial relationships and anatomical nomenclature (Terminologia Anatomica) before finalizing.`,
  },
  {
    id: 'human-physiology-expert',
    name: 'Human Physiology Expert',
    category: 'Medical & Imaging',
    specialty: 'Organ-system physiology, hemodynamics, neuro/respiratory/renal/endocrine/musculoskeletal mechanisms, clinical reference ranges, pathophysiology validation, and biological accuracy verification.',
    readOnly: true,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: [],
    systemPrompt: `You are a Human Physiology Expert (PhD/MD-level domain specialist).
- Provide rigorous physiological accuracy across cardiovascular/hemodynamic, pulmonary, neurophysiological, renal, endocrine, gastrointestinal, hematologic, and musculoskeletal systems.
- Cite exact physiological units (SI and conventional clinical units), normal adult/pediatric reference ranges, quantitative relationships (e.g., Frank-Starling, Poiseuille, Fick, Henderson-Hasselbalch, Nernst/Goldman), and pathophysiological mechanisms.
- Audit code, simulations, UI copy, clinical thresholds, and anatomical illustrations (using \`view_workspace_image\` on rendered PNGs/SVGs) for biological plausibility and flag any physiological or orientation inaccuracies clearly.`,
  },
  {
    id: 'implementer',
    name: 'Software Implementer',
    category: 'Engineering',
    specialty: 'TDD, clean modular code, feature implementation, refactoring, and automated unit/integration tests.',
    readOnly: false,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: ['test-driven-development'],
    systemPrompt: `You are a disciplined Software Implementer. Follow TDD (write failing test first, verify failure, write minimal clean code, verify pass), keep changes focused and DRY, and report exact test command outputs.`,
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    category: 'Engineering',
    specialty: 'Spec compliance review, security audit, edge-case detection, and code quality review (read-only).',
    readOnly: true,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: [],
    systemPrompt: `You are an adversarial Code Reviewer. Inspect code and tests critically for spec mismatches, security bugs, race conditions, and missing edge cases. Rank findings by severity (Critical / Important / Minor) with exact file and line citations.`,
  },
  {
    id: 'debugger',
    name: 'Systematic Debugger',
    category: 'Engineering',
    specialty: 'Root-cause tracing, minimal failing reproduction tests, and verified bug fixes.',
    readOnly: false,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: ['systematic-debugging'],
    systemPrompt: `You are a Systematic Debugger. Never guess-and-patch symptoms: reproduce the failure reliably, trace the root cause with evidence, write a regression test, apply the minimal fix, and verify the full test suite passes.`,
  },
  {
    id: 'researcher',
    name: 'Technical Researcher',
    category: 'Engineering',
    specialty: 'Read-only codebase exploration, dependency/API mapping, and concise technical synthesis.',
    readOnly: true,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: [],
    systemPrompt: `You are a Technical Researcher. Explore the workspace thoroughly using read-only tools and return a well-structured, evidence-backed summary with exact file paths and symbol names.`,
  },
  {
    id: 'security-auditor',
    name: 'Security Auditor',
    category: 'Quality & Security',
    specialty: 'STRIDE threat modeling, OWASP Top 10 & LLM Top 10 vulnerability auditing, auth/IDOR checks, secrets & dependency supply-chain review (read-only).',
    readOnly: true,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: ['security-and-hardening'],
    systemPrompt: `You are an experienced Security Engineer conducting a practical, exploitability-focused security audit (load the \`security-and-hardening\` skill and its \`references/security-checklist.md\` when helpful).
- Start from trust boundaries (HTTP inputs, uploads, webhooks, third-party APIs, file paths, shell arguments, and LLM outputs) and reason with STRIDE before listing findings.
- Audit input validation & injection (SQL/NoSQL/OS/XSS/path traversal/SSRF), authentication & authorization (IDOR, session flags, rate limits), secrets & PII handling, security headers/CORS, and dependency/supply-chain risk.
- Rank every finding by severity (Critical / High / Medium / Low) with exact file:line citations, exploit scenario or proof of concept, and a concrete fix — never suggest disabling security controls as a fix.
- Also acknowledge security practices done well.`,
  },
  {
    id: 'web-performance-auditor',
    name: 'Web Performance Auditor',
    category: 'Quality & Security',
    specialty: 'Core Web Vitals (LCP/INP/CLS), bundle/rendering/network bottleneck analysis, and measure-first profiling with strict metric honesty (read-only).',
    readOnly: true,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: ['performance-optimization'],
    systemPrompt: `You are a Web Performance Engineer auditing loading, rendering, and runtime efficiency (load the \`performance-optimization\` skill and its \`references/performance-checklist.md\` when helpful).
- Apply strict metric honesty: if you only inspect source code (Quick mode), tag findings as **potential impact** and never fabricate benchmark numbers; if live measurements, Lighthouse/trace JSON, or profiling outputs are available (Deep mode), cite the exact measured numbers.
- Check Core Web Vitals risks (LCP render-blocking assets, unoptimized images/missing dimensions for CLS, main-thread long tasks for INP), bundle bloat, unnecessary re-renders, N+1 queries, and unbounded fetches.
- Prioritize findings by user impact with file:line citations and concrete measurement commands to verify each fix.`,
  },
  {
    id: 'accessibility-auditor',
    name: 'Accessibility Auditor',
    category: 'Quality & Security',
    specialty: 'WCAG 2.2 AA conformance audits, semantic HTML/ARIA, keyboard & focus management, color contrast, and screen-reader verification guidance (read-only).',
    readOnly: true,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: ['accessibility-engineering'],
    systemPrompt: `You are an Accessibility Engineer auditing interfaces for WCAG 2.2 Level AA conformance (load the \`accessibility-engineering\` skill and its \`references/accessibility-checklist.md\` when helpful).
- Map every violation to its exact WCAG 2.2 Success Criterion (distinguishing hard violations from UX recommendations) and rank by real user impact (Critical / Serious / Moderate / Minor).
- Check keyboard navigation, visible focus indicators (never remove outlines or use tabindex > 0), semantic landmarks/headings, form labels & error announcements, ARIA roles/states, contrast ratios (4.5:1 normal text, 3:1 large text & UI components), and AI-generated UI anti-patterns.
- Be honest about automated vs manual verification: code inspection cannot confirm screen-reader announcements — tag assistive-technology checks as \`manual\` with exact reproduction steps and expected behavior.`,
  },
  {
    id: 'test-engineer',
    name: 'QA & Test Engineer',
    category: 'Quality & Security',
    specialty: 'Test strategy, coverage gap analysis, Prove-It failing bug reproductions, unit/integration/E2E tests, and edge-case/concurrency testing.',
    readOnly: false,
    allowVisualCompanion: false,
    providerId: '',
    model: '',
    defaultSkills: ['test-driven-development'],
    systemPrompt: `You are an experienced QA & Test Engineer focused on test strategy, coverage analysis, and high-signal automated tests.
- Test at the lowest level that captures real behavior (Unit for pure logic, Integration across boundaries, E2E for critical user flows) and test behavior rather than implementation details.
- For bugs, follow the Prove-It pattern: write a failing reproduction test first, confirm it fails for the right reason, then verify the fix makes it pass.
- Cover happy paths, empty/null inputs, boundary values, error paths, and concurrency/race conditions; keep tests isolated with no shared mutable state, mock only at system boundaries, and report exact test command outputs.`,
  },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath, data, mode = null) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  if (mode && process.platform !== 'win32') {
    try { fs.chmodSync(tmp, mode); } catch { /* ignore */ }
  }
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* ignore corrupted tail line */ }
  }
  return out;
}

function resolveProviderKey(profile) {
  if (profile.apiKey && String(profile.apiKey).trim()) {
    return { effectiveApiKey: String(profile.apiKey).trim(), keySource: 'saved' };
  }
  const envNames = [profile.envVar, ...(profile.envVarFallbacks || [])].filter(Boolean);
  for (const name of envNames) {
    if (process.env[name] && String(process.env[name]).trim()) {
      return { effectiveApiKey: String(process.env[name]).trim(), keySource: 'env' };
    }
  }
  return { effectiveApiKey: '', keySource: 'none' };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function normalizeStringList(val) {
  if (!Array.isArray(val)) return [];
  return [...new Set(val.map((x) => String(x || '').trim()).filter(Boolean))];
}

function normalizeEnabledExpertIds(val) {
  if (val === null || val === undefined) return null;
  if (!Array.isArray(val)) return null;
  return normalizeStringList(val);
}

function normalizeEnabledSkillPacks(val) {
  if (val === null || val === undefined) return null;
  if (!Array.isArray(val)) return null;
  const list = normalizeStringList(val);
  // Superpowers Core is always enabled as the single primary router
  if (!list.includes('superpowers')) list.unshift('superpowers');
  return list;
}

export function createStore({ dataDir }) {
  ensureDir(dataDir);
  const providersFile = path.join(dataDir, 'providers.json');
  const expertsFile = path.join(dataDir, 'experts.json');
  const settingsFile = path.join(dataDir, 'settings.json');
  const sessionsRoot = path.join(dataDir, 'sessions');
  ensureDir(sessionsRoot);

  if (!fs.existsSync(providersFile)) {
    atomicWriteJson(providersFile, DEFAULT_PROVIDERS, 0o600);
  } else {
    // Non-destructive upgrade: backfill default models for built-in providers whose models array is empty
    const existingProviders = readJsonSafe(providersFile, null);
    if (Array.isArray(existingProviders)) {
      const defaultsById = new Map(DEFAULT_PROVIDERS.map((d) => [d.id, d]));
      let changed = false;
      const upgraded = existingProviders.map((p) => {
        const def = p && defaultsById.get(p.id);
        if (def && (!Array.isArray(p.models) || p.models.length === 0) && Array.isArray(def.models) && def.models.length > 0) {
          changed = true;
          return { ...p, models: [...def.models] };
        }
        return p;
      });
      if (changed) {
        atomicWriteJson(providersFile, upgraded, 0o600);
      }
    }
  }
  if (!fs.existsSync(settingsFile)) {
    atomicWriteJson(settingsFile, { shell: 'auto', autoResumeOnRestart: true });
  }
  if (!fs.existsSync(expertsFile)) {
    atomicWriteJson(expertsFile, DEFAULT_EXPERTS);
  } else {
    // Non-destructive upgrade: append any newly introduced built-in experts
    // that are neither present nor explicitly deleted by the user, and backfill
    // defaultSkills on built-in experts that predate the field.
    const existingList = readJsonSafe(expertsFile, null);
    if (Array.isArray(existingList)) {
      const defaultsById = new Map(DEFAULT_EXPERTS.map((d) => [d.id, d]));
      let changed = false;
      const upgraded = existingList.map((e) => {
        if (e && e.defaultSkills === undefined) {
          const def = defaultsById.get(e.id);
          changed = true;
          return { ...e, defaultSkills: Array.isArray(def?.defaultSkills) ? [...def.defaultSkills] : [] };
        }
        return e;
      });
      const existingIds = new Set(upgraded.map((e) => e?.id).filter(Boolean));
      const rawSettings = readJsonSafe(settingsFile, {});
      const dismissed = new Set(Array.isArray(rawSettings?.dismissedDefaultExperts) ? rawSettings.dismissedDefaultExperts : []);
      const toAppend = DEFAULT_EXPERTS.filter((d) => !existingIds.has(d.id) && !dismissed.has(d.id));
      if (toAppend.length > 0) {
        upgraded.push(...structuredClone(toAppend));
        changed = true;
      }
      if (changed) {
        atomicWriteJson(expertsFile, upgraded);
      }
    }
  }

  function sessionDir(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(sessionsRoot, id);
  }

  function getRawProviders() {
    const list = readJsonSafe(providersFile, DEFAULT_PROVIDERS);
    return Array.isArray(list) ? list : structuredClone(DEFAULT_PROVIDERS);
  }

  function getProviders() {
    return getRawProviders().map((p) => {
      const { effectiveApiKey, keySource } = resolveProviderKey(p);
      return { ...p, effectiveApiKey, keySource };
    });
  }

  function getProvidersMasked() {
    return getProviders().map((p) => {
      const { apiKey, effectiveApiKey, ...rest } = p;
      return {
        ...rest,
        hasKey: Boolean(effectiveApiKey),
        keyPreview: p.keySource === 'saved' ? maskKey(apiKey) : p.keySource === 'env' ? `env:${p.envVar}` : '',
      };
    });
  }

  function getProvider(id) {
    return getProviders().find((p) => p.id === id) || null;
  }

  function upsertProvider(profile) {
    if (!profile || !profile.id || !profile.name || !profile.kind) {
      throw new Error('Provider requires id, name, and kind');
    }
    const list = getRawProviders();
    const idx = list.findIndex((p) => p.id === profile.id);
    const existing = idx >= 0 ? list[idx] : {};
    const {
      effectiveApiKey: _drop1,
      keySource: _drop2,
      hasKey: _drop3,
      keyPreview: _drop4,
      ...cleanProfile
    } = profile;
    const merged = {
      ...existing,
      ...cleanProfile,
      apiKey: cleanProfile.apiKey === undefined ? (existing.apiKey || '') : cleanProfile.apiKey,
      models: Array.isArray(cleanProfile.models) ? cleanProfile.models : (existing.models || []),
      extraHeaders: cleanProfile.extraHeaders && typeof cleanProfile.extraHeaders === 'object'
        ? cleanProfile.extraHeaders
        : (existing.extraHeaders || {}),
      toolMode: cleanProfile.toolMode || existing.toolMode || 'auto',
    };
    if (idx >= 0) list[idx] = merged;
    else list.push(merged);
    atomicWriteJson(providersFile, list, 0o600);
    return getProvider(merged.id);
  }

  function deleteProvider(id) {
    const list = getRawProviders();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    atomicWriteJson(providersFile, next, 0o600);
    return true;
  }

  function getExpertRoster() {
    const list = readJsonSafe(expertsFile, DEFAULT_EXPERTS);
    return Array.isArray(list) ? list : structuredClone(DEFAULT_EXPERTS);
  }

  function getExpertProfile(id) {
    return getExpertRoster().find((e) => e.id === id) || null;
  }

  function upsertExpertProfile(profile) {
    if (!profile || !profile.id || !profile.name) {
      throw new Error('Expert profile requires id and name');
    }
    const cleanId = String(profile.id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const list = getExpertRoster();
    const idx = list.findIndex((e) => e.id === cleanId);
    const existing = idx >= 0 ? list[idx] : {};
    const merged = {
      id: cleanId,
      name: profile.name,
      category: profile.category || existing.category || 'Custom',
      specialty: profile.specialty || existing.specialty || '',
      readOnly: profile.readOnly !== undefined ? Boolean(profile.readOnly) : Boolean(existing.readOnly),
      allowVisualCompanion: profile.allowVisualCompanion !== undefined
        ? Boolean(profile.allowVisualCompanion)
        : Boolean(existing.allowVisualCompanion),
      providerId: profile.providerId !== undefined ? profile.providerId : (existing.providerId || ''),
      model: profile.model !== undefined ? profile.model : (existing.model || ''),
      defaultSkills: profile.defaultSkills !== undefined
        ? normalizeStringList(profile.defaultSkills)
        : normalizeStringList(existing.defaultSkills),
      systemPrompt: profile.systemPrompt !== undefined ? profile.systemPrompt : (existing.systemPrompt || ''),
    };
    if (idx >= 0) list[idx] = merged;
    else list.push(merged);
    atomicWriteJson(expertsFile, list);
    // If re-adding a previously dismissed default expert, clear its dismissal
    const curSettings = readJsonSafe(settingsFile, {});
    if (Array.isArray(curSettings?.dismissedDefaultExperts) && curSettings.dismissedDefaultExperts.includes(cleanId)) {
      atomicWriteJson(settingsFile, {
        ...curSettings,
        dismissedDefaultExperts: curSettings.dismissedDefaultExperts.filter((x) => x !== cleanId),
      });
    }
    return merged;
  }

  function deleteExpertProfile(id) {
    const list = getExpertRoster();
    const next = list.filter((e) => e.id !== id);
    if (next.length === list.length) return false;
    atomicWriteJson(expertsFile, next);
    if (DEFAULT_EXPERTS.some((d) => d.id === id)) {
      const curSettings = readJsonSafe(settingsFile, {});
      const dismissed = new Set(Array.isArray(curSettings?.dismissedDefaultExperts) ? curSettings.dismissedDefaultExperts : []);
      dismissed.add(id);
      atomicWriteJson(settingsFile, { ...curSettings, dismissedDefaultExperts: [...dismissed] });
    }
    return true;
  }

  function getSettings() {
    const raw = readJsonSafe(settingsFile, { shell: 'auto', autoResumeOnRestart: true, remoteAccessEnabled: false, allowedOrigins: [] });
    return {
      shell: 'auto',
      ...raw,
      autoResumeOnRestart: raw?.autoResumeOnRestart !== false,
      remoteAccessEnabled: Boolean(raw?.remoteAccessEnabled),
      allowedOrigins: Array.isArray(raw?.allowedOrigins) ? raw.allowedOrigins : [],
    };
  }

  function updateSettings(patch) {
    const next = { ...getSettings(), ...patch };
    atomicWriteJson(settingsFile, next);
    return next;
  }

  function createSession(input) {
    const now = new Date().toISOString();
    const id = input.id || `s_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const workspacePath = path.resolve(input.workspacePath || process.cwd());
    if (input.createIfMissing !== false && !fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
    }
    const session = {
      id,
      title: (input.title || 'Untitled Session').trim(),
      workspacePath,
      effectiveWorkDir: workspacePath,
      worktreeBranch: null,
      phase: 'interview',
      providerId: input.providerId || 'anthropic',
      model: input.model || '',
      coordinatorProviderId: input.coordinatorProviderId || '',
      coordinatorModel: input.coordinatorModel || '',
      expertProviderId: input.expertProviderId || '',
      expertModel: input.expertModel || '',
      pinnedSkills: Array.isArray(input.pinnedSkills) ? input.pinnedSkills : [],
      enabledExpertIds: normalizeEnabledExpertIds(input.enabledExpertIds),
      enabledSkillPacks: normalizeEnabledSkillPacks(input.enabledSkillPacks),
      rules: input.rules || '',
      plan: input.plan || '',
      tasks: Array.isArray(input.tasks) ? input.tasks : [],
      uninterruptedMode: input.uninterruptedMode !== false,
      startedAt: null,
      maxTurns: Number.isInteger(input.maxTurns) ? input.maxTurns : 100,
      turnCount: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    const dir = sessionDir(id);
    ensureDir(path.join(dir, 'experts'));
    ensureDir(path.join(dir, 'screens'));
    ensureDir(path.join(dir, 'attachments'));
    atomicWriteJson(path.join(dir, 'session.json'), session);
    atomicWriteJson(path.join(dir, 'coordinator.json'), {
      status: 'idle',
      turnCount: 0,
      currentTool: null,
      directives: [],
      messages: [],
      lastError: null,
      updatedAt: now,
    });
    return session;
  }

  function getSession(id) {
    try {
      const file = path.join(sessionDir(id), 'session.json');
      const s = readJsonSafe(file, null);
      if (s && s.uninterruptedMode === undefined) s.uninterruptedMode = true;
      return s;
    } catch {
      return null;
    }
  }

  function listSessions() {
    if (!fs.existsSync(sessionsRoot)) return [];
    const out = [];
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const s = readJsonSafe(path.join(sessionsRoot, entry.name, 'session.json'), null);
      if (s) {
        const coord = getCoordinator(s.id);
        const experts = listExperts(s.id);
        out.push({
          ...s,
          coordinatorStatus: coord.status,
          activeExperts: experts.filter((e) => e.status === 'running').length,
          totalExperts: experts.length,
        });
      }
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  function updateSession(id, patch) {
    const existing = getSession(id);
    if (!existing) throw new Error(`Session not found: ${id}`);
    const cleanPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(cleanPatch, 'enabledExpertIds')) {
      cleanPatch.enabledExpertIds = normalizeEnabledExpertIds(cleanPatch.enabledExpertIds);
    }
    if (Object.prototype.hasOwnProperty.call(cleanPatch, 'enabledSkillPacks')) {
      cleanPatch.enabledSkillPacks = normalizeEnabledSkillPacks(cleanPatch.enabledSkillPacks);
    }
    const next = {
      ...existing,
      ...cleanPatch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(path.join(sessionDir(id), 'session.json'), next);
    return next;
  }

  function deleteSession(id) {
    const dir = sessionDir(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  function appendMessage(sessionId, msg) {
    const entry = {
      id: msg.id || `m_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: msg.timestamp || new Date().toISOString(),
      ...msg,
    };
    appendJsonl(path.join(sessionDir(sessionId), 'messages.jsonl'), entry);
    return entry;
  }

  function getMessages(sessionId) {
    return readJsonl(path.join(sessionDir(sessionId), 'messages.jsonl'));
  }

  function getCoordinator(sessionId) {
    const file = path.join(sessionDir(sessionId), 'coordinator.json');
    return readJsonSafe(file, {
      status: 'idle',
      turnCount: 0,
      directives: [],
      messages: [],
      lastError: null,
      updatedAt: null,
    });
  }

  function saveCoordinator(sessionId, coord) {
    const next = {
      ...getCoordinator(sessionId),
      ...coord,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJson(path.join(sessionDir(sessionId), 'coordinator.json'), next);
    return next;
  }

  function saveExpert(sessionId, expert) {
    if (!expert?.id) throw new Error('Expert requires id');
    const file = path.join(sessionDir(sessionId), 'experts', `${expert.id}.json`);
    const next = {
      updatedAt: new Date().toISOString(),
      ...expert,
    };
    atomicWriteJson(file, next);
    return next;
  }

  function getExpert(sessionId, expertId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(expertId)) return null;
    const file = path.join(sessionDir(sessionId), 'experts', `${expertId}.json`);
    return readJsonSafe(file, null);
  }

  function listExperts(sessionId) {
    const dir = path.join(sessionDir(sessionId), 'experts');
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const exp = readJsonSafe(path.join(dir, entry.name), null);
      if (exp) out.push(exp);
    }
    return out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  function writeScreen(sessionId, filename, html) {
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '-');
    const finalName = safeName.endsWith('.html') ? safeName : `${safeName}.html`;
    const screensDir = path.join(sessionDir(sessionId), 'screens');
    ensureDir(screensDir);
    const full = path.join(screensDir, finalName);
    fs.writeFileSync(full, html, 'utf8');
    // Touch mtime monotonically if rapid writes occur
    return finalName;
  }

  function listScreens(sessionId) {
    const screensDir = path.join(sessionDir(sessionId), 'screens');
    if (!fs.existsSync(screensDir)) return [];
    return fs.readdirSync(screensDir)
      .filter((f) => f.endsWith('.html') && !f.startsWith('._'))
      .map((f) => {
        const full = path.join(screensDir, f);
        const st = fs.statSync(full);
        return { filename: f, mtimeMs: st.mtimeMs, sizeBytes: st.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.filename.localeCompare(a.filename));
  }

  function getScreen(sessionId, filename) {
    if (!filename) return null;
    const safe = path.basename(String(filename));
    if (!safe.endsWith('.html') || safe.startsWith('._')) return null;
    const full = path.join(sessionDir(sessionId), 'screens', safe);
    if (!fs.existsSync(full)) return null;
    return { filename: safe, html: fs.readFileSync(full, 'utf8') };
  }

  function getLatestScreen(sessionId) {
    const files = listScreens(sessionId);
    if (files.length === 0) return null;
    return getScreen(sessionId, files[0].filename);
  }

  const ALLOWED_IMAGE_MIME = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
  };
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

  function saveAttachment(sessionId, { filename = 'image.png', mimeType = 'image/png', base64Data = '', dataUrl = '' }) {
    let resolvedMime = String(mimeType || '').toLowerCase().trim();
    let b64 = String(base64Data || '').trim();
    if (dataUrl && !b64) {
      const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/s);
      if (m) {
        resolvedMime = m[1].toLowerCase().trim();
        b64 = m[2].trim();
      }
    }
    const ext = ALLOWED_IMAGE_MIME[resolvedMime];
    if (!ext) {
      throw Object.assign(new Error(`Unsupported image type: ${resolvedMime || 'unknown'}`), { status: 400 });
    }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) {
      throw Object.assign(new Error('Empty image data'), { status: 400 });
    }
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      throw Object.assign(new Error('Image exceeds 10MB limit'), { status: 413 });
    }

    const attDir = path.join(sessionDir(sessionId), 'attachments');
    ensureDir(attDir);
    const id = `att_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const safeName = path.basename(filename || `image${ext}`).replace(/[^a-zA-Z0-9._-]/g, '-');
    const filePath = path.join(attDir, `${id}${ext}`);
    fs.writeFileSync(filePath, buf);
    const meta = {
      id,
      filename: safeName,
      mimeType: resolvedMime,
      ext,
      sizeBytes: buf.length,
      createdAt: new Date().toISOString(),
    };
    atomicWriteJson(path.join(attDir, `${id}.json`), meta);
    return meta;
  }

  function getAttachment(sessionId, attId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(attId || '')) return null;
    const attDir = path.join(sessionDir(sessionId), 'attachments');
    const meta = readJsonSafe(path.join(attDir, `${attId}.json`), null);
    if (!meta) return null;
    const filePath = path.join(attDir, `${meta.id}${meta.ext}`);
    if (!fs.existsSync(filePath)) return null;
    return {
      ...meta,
      filePath,
      buffer: fs.readFileSync(filePath),
    };
  }

  function listAttachments(sessionId) {
    const attDir = path.join(sessionDir(sessionId), 'attachments');
    if (!fs.existsSync(attDir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(attDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const meta = readJsonSafe(path.join(attDir, entry.name), null);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }

  function appendCompanionEvent(sessionId, event) {
    const entry = {
      timestamp: Date.now(),
      ...event,
    };
    appendJsonl(path.join(sessionDir(sessionId), 'events.jsonl'), entry);
    return entry;
  }

  function getCompanionEvents(sessionId, limit = 50) {
    const all = readJsonl(path.join(sessionDir(sessionId), 'events.jsonl'));
    return limit > 0 ? all.slice(-limit) : all;
  }

  function findDanglingToolCalls(messages) {
    const answered = new Set();
    let lastAssistant = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'tool' && m.toolCallId) {
        answered.add(m.toolCallId);
      } else if (m.role === 'assistant') {
        lastAssistant = m;
        break;
      } else if (m.role === 'user') {
        break;
      }
    }
    if (!lastAssistant || !Array.isArray(lastAssistant.toolCalls)) return [];
    return lastAssistant.toolCalls.filter((tc) => tc.id && !answered.has(tc.id));
  }

  function reconcileOnStartup() {
    const pausedSessions = [];
    const autoResumableSessions = [];
    const stoppedExperts = [];
    for (const s of listSessions()) {
      const coord = getCoordinator(s.id);
      const coordDangling = findDanglingToolCalls(coord.messages || []);
      if (coordDangling.length > 0) {
        for (const tc of coordDangling) {
          coord.messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name || 'tool',
            content: '[Interrupted by server restart]',
          });
        }
        saveCoordinator(s.id, coord);
      }

      const subDangling = findDanglingToolCalls(getMessages(s.id));
      for (const tc of subDangling) {
        appendMessage(s.id, {
          role: 'tool',
          toolCallId: tc.id,
          toolName: tc.name || 'tool',
          content: '[Interrupted by server restart]',
        });
      }

      if (s.phase === 'running' || coord.status === 'running') {
        updateSession(s.id, { phase: 'paused' });
        saveCoordinator(s.id, { status: 'paused' });
        appendMessage(s.id, {
          role: 'system',
          content: 'Paused after server restart — click Resume to continue Coordinator execution.',
        });
        pausedSessions.push(s.id);
        if (s.uninterruptedMode !== false) {
          autoResumableSessions.push(s.id);
        }
      }
      for (const exp of listExperts(s.id)) {
        if (exp.status === 'running') {
          saveExpert(s.id, { ...exp, status: 'stopped', error: 'Stopped due to server restart' });
          stoppedExperts.push(exp.id);
        }
      }
    }
    return { pausedSessions, autoResumableSessions, stoppedExperts };
  }

  return {
    dataDir,
    getProviders,
    getProvidersMasked,
    getProvider,
    upsertProvider,
    deleteProvider,
    getExpertRoster,
    getExpertProfile,
    upsertExpertProfile,
    deleteExpertProfile,
    getSettings,
    updateSettings,
    createSession,
    getSession,
    listSessions,
    updateSession,
    deleteSession,
    appendMessage,
    getMessages,
    getCoordinator,
    saveCoordinator,
    saveExpert,
    getExpert,
    listExperts,
    writeScreen,
    listScreens,
    getScreen,
    getLatestScreen,
    saveAttachment,
    getAttachment,
    listAttachments,
    appendCompanionEvent,
    getCompanionEvents,
    reconcileOnStartup,
  };
}
