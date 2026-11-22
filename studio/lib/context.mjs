export const DEFAULT_PROMPT_BUDGET_CHARS = 120_000;
export const MIN_OVERFLOW_BUDGET_CHARS = 16_000;
export const MAX_WORKING_MEMORY_CHARS = 12_000;

export const CONTEXT_MODE_PRESETS = {
  compact: { chars: 32_000, label: 'Compact (~8K tok)' },
  standard: { chars: 120_000, label: 'Standard (~30K tok)' },
  large: { chars: 260_000, label: 'Large (~65K tok)' },
};

export function normalizeContextMode(mode) {
  const clean = String(mode || 'auto').trim().toLowerCase();
  if (clean === 'compact' || clean === 'standard' || clean === 'large') return clean;
  return 'auto';
}

export function estimateTokens(chars) {
  const n = Number(chars) || 0;
  return Math.max(0, Math.round(n / 4));
}

export function resolveModelContextProfile(provider, model) {
  const pid = String(provider?.id || '').toLowerCase();
  const kind = String(provider?.kind || '').toLowerCase();
  const m = String(model || provider?.defaultModel || '').toLowerCase();

  // Groq free/fast tier has tight request/TPM limits — keep sweet spot fast & compact
  if (pid === 'groq') {
    return {
      contextTokens: 128_000,
      sweetSpotChars: 32_000,
      sweetSpotTokens: 8_000,
      tierLabel: 'Groq Free/Fast (8K tok sweet spot)',
    };
  }

  // Local Ollama typically defaults to 8K–32K num_ctx depending on model size
  if (pid === 'ollama') {
    const isMediumOrLarge = /(14b|24b|26b|27b|31b|32b|70b|72b|120b)/.test(m);
    const chars = isMediumOrLarge ? 48_000 : 32_000;
    return {
      contextTokens: isMediumOrLarge ? 32_000 : 16_000,
      sweetSpotChars: chars,
      sweetSpotTokens: estimateTokens(chars),
      tierLabel: `Local Ollama (${estimateTokens(chars) / 1000}K tok sweet spot)`,
    };
  }

  // OpenRouter :free endpoints and auto-router: generous reasoning window, safe for free-tier limits
  if (pid === 'openrouter' && (m.endsWith(':free') || m === 'openrouter/free')) {
    return {
      contextTokens: 128_000,
      sweetSpotChars: 80_000,
      sweetSpotTokens: 20_000,
      tierLabel: 'OpenRouter Free (20K tok sweet spot)',
    };
  }

  // Long-context 256K–1M cloud models (Google Gemini, Abliteration.ai 1M/262K, GLM-5.3, Kimi K3.1, DeepSeek V4.1)
  if (
    kind === 'gemini' ||
    pid === 'gemini' ||
    pid === 'abliteration' ||
    /(gemini-|gemma-4|abliterated-model|glm-5|kimi-k3|deepseek-v4\.1)/.test(m)
  ) {
    return {
      contextTokens: m.includes('abliterated-model') && !m.includes('large') ? 262_000 : 1_000_000,
      sweetSpotChars: 240_000,
      sweetSpotTokens: 60_000,
      tierLabel: 'Long-Context Cloud (60K tok sweet spot)',
    };
  }

  // Anthropic Claude (200K–1M context)
  if (kind === 'anthropic' || pid === 'anthropic' || m.startsWith('claude-')) {
    return {
      contextTokens: 200_000,
      sweetSpotChars: 180_000,
      sweetSpotTokens: 45_000,
      tierLabel: 'Claude (45K tok sweet spot)',
    };
  }

  // Standard 128K–200K cloud models (DeepSeek, Qwen, Cerebras, OpenRouter paid)
  if (pid === 'deepseek' || pid === 'qwen' || pid === 'cerebras' || pid === 'openrouter') {
    return {
      contextTokens: 128_000,
      sweetSpotChars: 160_000,
      sweetSpotTokens: 40_000,
      tierLabel: 'Standard Cloud (40K tok sweet spot)',
    };
  }

  // Unknown custom OpenAI-compatible endpoint: balanced default
  return {
    contextTokens: 128_000,
    sweetSpotChars: 100_000,
    sweetSpotTokens: 25_000,
    tierLabel: 'Custom API (25K tok sweet spot)',
  };
}

export function resolveContextBudget({ session = null, provider = null, model = '' } = {}) {
  const mode = normalizeContextMode(session?.contextMode);
  const profile = resolveModelContextProfile(provider, model);
  if (mode !== 'auto' && CONTEXT_MODE_PRESETS[mode]) {
    const preset = CONTEXT_MODE_PRESETS[mode];
    return {
      mode,
      maxChars: preset.chars,
      maxTokens: estimateTokens(preset.chars),
      modelContextTokens: profile.contextTokens,
      tierLabel: preset.label,
    };
  }
  return {
    mode: 'auto',
    maxChars: profile.sweetSpotChars,
    maxTokens: profile.sweetSpotTokens,
    modelContextTokens: profile.contextTokens,
    tierLabel: profile.tierLabel,
  };
}

export function buildOverflowLadder(initialMaxChars) {
  const start = Math.max(MIN_OVERFLOW_BUDGET_CHARS, Math.round(Number(initialMaxChars) || DEFAULT_PROMPT_BUDGET_CHARS));
  const candidates = [
    start,
    Math.round(start * 0.55),
    Math.round(start * 0.30),
    MIN_OVERFLOW_BUDGET_CHARS,
  ];
  const out = [];
  for (const c of candidates) {
    const clamped = Math.max(MIN_OVERFLOW_BUDGET_CHARS, c);
    if (out.length === 0 || clamped < out[out.length - 1]) {
      out.push(clamped);
    }
  }
  return out;
}

export function estimateMessageSize(m) {
  if (!m) return 0;
  const c = typeof m.content === 'string' ? m.content.length : 0;
  const t = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
  return c + t + 32;
}

export function estimateMessagesChars(messages = []) {
  let total = 0;
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue;
    total += estimateMessageSize(m);
  }
  return total;
}

function formatTrimmedToolContent(msg) {
  const raw = String(msg.content || '');
  const origLen = raw.length;
  const toolTag = msg.toolName ? `${msg.toolName}, ` : '';
  const preview = raw.slice(0, 260).replace(/\s+$/, '');
  return `${preview}\n... [trimmed earlier tool output (${toolTag}${origLen} chars — re-read if exact details are needed)]`;
}

export function buildPromptWindow(messages, { maxChars = DEFAULT_PROMPT_BUDGET_CHARS, returnMeta = false } = {}) {
  const cloned = (messages || [])
    .filter((m) => m && m.role && m.role !== 'system')
    .map((m) => ({ ...m }));

  // Precompute per-message sizes ONCE (O(N))
  const sizes = cloned.map(estimateMessageSize);
  const initialTotal = sizes.reduce((a, b) => a + b, 0);
  let total = initialTotal;
  let trimmedToolCount = 0;

  if (total <= maxChars) {
    return returnMeta
      ? { messages: cloned, droppedMessages: [], droppedCount: 0, keptChars: total, totalChars: initialTotal, trimmedToolCount: 0 }
      : cloned;
  }

  const trimToolAt = (i) => {
    if (cloned[i].role === 'tool' && String(cloned[i].content || '').length > 400) {
      const nextContent = formatTrimmedToolContent(cloned[i]);
      const nextSize = nextContent.length + (cloned[i].toolCalls ? JSON.stringify(cloned[i].toolCalls).length : 0) + 32;
      if (nextSize < sizes[i]) {
        cloned[i].content = nextContent;
        total += nextSize - sizes[i];
        sizes[i] = nextSize;
        trimmedToolCount++;
      }
    }
  };

  // Pass 1: Collapse older large tool outputs first (protecting the latest 4 messages intact)
  const protectCount = Math.min(4, cloned.length);
  for (let i = 0; i < cloned.length - protectCount && total > maxChars; i++) {
    trimToolAt(i);
  }
  if (total <= maxChars) {
    return returnMeta
      ? { messages: cloned, droppedMessages: [], droppedCount: 0, keptChars: total, totalChars: initialTotal, trimmedToolCount }
      : cloned;
  }

  // Pass 1b: If still over budget, trim any remaining oversized tool outputs too
  for (let i = 0; i < cloned.length && total > maxChars; i++) {
    trimToolAt(i);
  }
  if (total <= maxChars) {
    return returnMeta
      ? { messages: cloned, droppedMessages: [], droppedCount: 0, keptChars: total, totalChars: initialTotal, trimmedToolCount }
      : cloned;
  }

  // Pass 2: Drop oldest turns in O(N) while keeping assistant(toolCalls)+tool groups atomic
  const groups = [];
  const groupSizes = [];
  let keptTotal = 0;
  for (let i = 0; i < cloned.length; i++) {
    const m = cloned[i];
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const grp = [m];
      let gSize = sizes[i];
      while (i + 1 < cloned.length && cloned[i + 1].role === 'tool') {
        i++;
        grp.push(cloned[i]);
        gSize += sizes[i];
      }
      groups.push(grp);
      groupSizes.push(gSize);
      keptTotal += gSize;
    } else if (m.role === 'tool') {
      continue;
    } else {
      groups.push([m]);
      groupSizes.push(sizes[i]);
      keptTotal += sizes[i];
    }
  }

  let anchorIdx = 0;
  let dropCursor = 1;
  let hasAnchor = groups.length > 0;
  const droppedGroupIndices = [];
  const remainingCount = () => (hasAnchor ? 1 : 0) + Math.max(0, groups.length - dropCursor);

  while (remainingCount() > 2 && keptTotal > maxChars) {
    if (hasAnchor && groups[anchorIdx][0]?.role === 'user' && dropCursor < groups.length && groups[dropCursor][0]?.role !== 'user') {
      keptTotal -= groupSizes[dropCursor];
      droppedGroupIndices.push(dropCursor);
      dropCursor++;
    } else if (hasAnchor) {
      keptTotal -= groupSizes[anchorIdx];
      droppedGroupIndices.push(anchorIdx);
      if (dropCursor < groups.length) {
        anchorIdx = dropCursor;
        dropCursor++;
      } else {
        hasAnchor = false;
      }
    } else {
      break;
    }
  }

  const kept = [];
  if (hasAnchor && anchorIdx < groups.length) kept.push({ idx: anchorIdx, grp: groups[anchorIdx] });
  for (let g = dropCursor; g < groups.length; g++) kept.push({ idx: g, grp: groups[g] });

  const firstUser = cloned.find((m) => m.role === 'user');
  let start = 0;
  while (start < kept.length - 1 && kept[start].grp[0]?.role !== 'user') {
    droppedGroupIndices.push(kept[start].idx);
    start++;
  }

  const result = [];
  for (let g = start; g < kept.length; g++) {
    for (const m of kept[g].grp) result.push(m);
  }
  if (result.length > 0 && result[0].role !== 'user') {
    const anchor = firstUser
      ? { role: 'user', content: String(firstUser.content || '').slice(0, 500) }
      : { role: 'user', content: 'Continue.' };
    result.unshift(anchor);
  }

  if (!returnMeta) return result;

  droppedGroupIndices.sort((a, b) => a - b);
  const droppedMessages = [];
  for (const gIdx of droppedGroupIndices) {
    for (const m of groups[gIdx]) droppedMessages.push(m);
  }

  return {
    messages: result,
    droppedMessages,
    droppedCount: droppedMessages.length,
    keptChars: estimateMessagesChars(result),
    totalChars: initialTotal,
    trimmedToolCount,
  };
}

export function buildDeterministicMemoryDelta(droppedMessages = []) {
  if (!Array.isArray(droppedMessages) || droppedMessages.length === 0) return '';

  const filesTouched = new Set();
  const commandsRun = [];
  const expertsSpawned = [];
  const userDirectives = [];
  const keyNotes = [];

  for (const m of droppedMessages) {
    if (!m) continue;
    if (m.role === 'user') {
      const txt = String(m.content || '').replace(/\s+/g, ' ').trim();
      if (txt && !txt.startsWith('[System')) {
        userDirectives.push(txt.slice(0, 180));
      }
    } else if (m.role === 'assistant') {
      const txt = String(m.content || '').replace(/\s+/g, ' ').trim();
      if (txt.length > 20) {
        keyNotes.push(txt.slice(0, 200));
      }
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          const name = tc?.name || '';
          const args = tc?.arguments || {};
          if ((name === 'write_file' || name === 'edit_file') && args.path) {
            filesTouched.add(String(args.path));
          } else if (name === 'run_command' && args.command) {
            commandsRun.push(String(args.command).slice(0, 100));
          } else if (name === 'spawn_expert') {
            const role = args.role || args.expertId || 'expert';
            const task = String(args.task || '').replace(/\s+/g, ' ').slice(0, 100);
            expertsSpawned.push(`${role}${task ? `: ${task}` : ''}`);
          }
        }
      }
    }
  }

  const lines = [];
  if (userDirectives.length > 0) {
    lines.push('**Earlier User Directives:**');
    for (const d of userDirectives.slice(-5)) lines.push(`- ${d}`);
  }
  if (filesTouched.size > 0) {
    lines.push(`**Files Modified/Created:** ${[...filesTouched].slice(-16).join(', ')}`);
  }
  if (expertsSpawned.length > 0) {
    lines.push('**Earlier Experts Dispatched:**');
    for (const e of expertsSpawned.slice(-6)) lines.push(`- ${e}`);
  }
  if (commandsRun.length > 0) {
    lines.push(`**Commands Run:** ${[...new Set(commandsRun)].slice(-6).join(' | ')}`);
  }
  if (keyNotes.length > 0) {
    lines.push('**Key Earlier Conclusions:**');
    for (const n of keyNotes.slice(-4)) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

export function mergeWorkingMemory(existingMemory = '', deltaText = '', { maxChars = MAX_WORKING_MEMORY_CHARS } = {}) {
  const existing = String(existingMemory || '').trim();
  const delta = String(deltaText || '').trim();
  if (!delta) return existing.slice(-maxChars);
  if (!existing) return delta.slice(0, maxChars);

  const combined = `${existing}\n\n${delta}`;
  if (combined.length <= maxChars) return combined;
  // Keep the most recent portion cleanly bounded at a newline boundary
  const slice = combined.slice(combined.length - maxChars);
  const nl = slice.indexOf('\n');
  return nl > 0 && nl < 400 ? slice.slice(nl + 1).trim() : slice.trim();
}

export function buildCompactionPrompt(existingMemory = '', droppedMessages = [], { tier = 'coordinator' } = {}) {
  const formatted = [];
  let charBudget = 22_000;
  for (const m of droppedMessages || []) {
    if (!m || m.role === 'system') continue;
    let line = '';
    if (m.role === 'user') {
      line = `USER: ${String(m.content || '').slice(0, 1200)}`;
    } else if (m.role === 'assistant') {
      const textPart = String(m.content || '').slice(0, 1200);
      const tcPart = Array.isArray(m.toolCalls) && m.toolCalls.length > 0
        ? ` [tools: ${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.arguments || {}).slice(0, 140)})`).join(', ')}]`
        : '';
      line = `ASSISTANT: ${textPart}${tcPart}`.trim();
    } else if (m.role === 'tool') {
      line = `TOOL(${m.toolName || 'result'}): ${String(m.content || '').slice(0, 400)}`;
    }
    if (!line) continue;
    if (line.length > charBudget) {
      if (charBudget > 200) formatted.push(line.slice(0, charBudget));
      break;
    }
    formatted.push(line);
    charBudget -= line.length + 1;
  }

  return [
    `Update the persistent **Session Working Memory** (${tier} history compaction) so any model taking over this session has complete continuity without needing the dropped raw messages.`,
    '',
    'Requirements:',
    '- Merge the existing Working Memory with the newly rolled-off messages below into ONE clean, concise markdown summary (target 400–1,200 words, max 10,000 chars).',
    '- Preserve exact file paths, symbol names, user preferences/decisions, completed work, verified test/command outcomes, and failed approaches not to repeat.',
    '- Drop noisy intermediate tool output, duplicate status checks, and superseded drafts.',
    '- Use short bullet lists under these headings: `## Decisions & Constraints`, `## Files & Artifacts`, `## Verified Progress`, `## Open Issues & Avoided Pitfalls`.',
    '- Output ONLY the updated Working Memory markdown (no preamble or code fences).',
    '',
    existingMemory && existingMemory.trim()
      ? `### Existing Working Memory\n${existingMemory.trim().slice(0, 10_000)}`
      : '### Existing Working Memory\n(none yet)',
    '',
    `### Newly Rolled-Off Messages (${droppedMessages.length} messages)\n${formatted.join('\n')}`,
  ].join('\n');
}
