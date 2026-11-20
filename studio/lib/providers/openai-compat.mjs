import crypto from 'node:crypto';
import {
  buildPromptToolsInstructions,
  formatPromptToolResult,
  parsePromptToolCalls,
} from './prompt-tools.mjs';

const promptFallbackCache = new Set();
const textOnlyImageFallbackCache = new Set();

export function makeProviderError(status, message, raw = '') {
  const err = new Error(message || `Provider HTTP ${status}`);
  err.status = status;
  err.raw = raw;
  const lower = `${message} ${raw}`.toLowerCase();
  err.isContextOverflow =
    status === 400 &&
    /context length|maximum context|too many tokens|token limit|context window|prompt is too long/.test(lower);
  err.isToolsUnsupported =
    (status === 400 || status === 422) &&
    (
      (/tool|function.?call/.test(lower) &&
        /not support|unsupported|invalid|unrecognized|unknown|enable-auto-tool-choice|does not support|support tool use|extra inputs/.test(lower)) ||
      /extra inputs are not permitted.*tools/.test(lower)
    );
  err.isImagesUnsupported =
    (status === 400 || status === 422) &&
    /image_url|multimodal|vision|image input|not support.*image|expected.*string.*content/.test(lower);
  err.retryable = status === 429 || (status >= 500 && status <= 599);
  return err;
}

export async function* readSseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines = [];

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join('\n') };
            dataLines = [];
          }
          eventName = 'message';
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
    }
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join('\n') };
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function buildOpenAiMessages(systemPrompt, messages, promptToolMode, stripImages = false) {
  const out = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: String(m.content || '') });
    } else if (m.role === 'user') {
      const atts = Array.isArray(m.hydratedAttachments) ? m.hydratedAttachments : [];
      if (atts.length === 0) {
        out.push({ role: 'user', content: String(m.content || '') });
      } else {
        const textParts = [String(m.content || '')];
        const imageParts = [];
        for (const att of atts) {
          if (att.mimeType === 'image/svg+xml' && att.svgText) {
            textParts.push(`\n[Attached SVG: ${att.filename} (id: ${att.id})]\n\`\`\`xml\n${att.svgText.slice(0, 12000)}\n\`\`\``);
          } else if (!stripImages && att.base64) {
            textParts.push(`\n[Attached image: ${att.filename} (id: ${att.id})]`);
            imageParts.push({
              type: 'image_url',
              image_url: { url: `data:${att.mimeType};base64,${att.base64}` },
            });
          } else {
            textParts.push(`\n[Attached image: ${att.filename} (id: ${att.id}, ${att.mimeType}) — text-only model; use save_attachment_to_workspace to inspect or process]`);
          }
        }
        const combinedText = textParts.join('\n').trim();
        if (imageParts.length > 0) {
          out.push({
            role: 'user',
            content: [{ type: 'text', text: combinedText || 'See attached image(s).' }, ...imageParts],
          });
        } else {
          out.push({ role: 'user', content: combinedText });
        }
      }
    } else if (m.role === 'assistant') {
      if (!promptToolMode && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
          })),
        });
      } else if (promptToolMode && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        const tags = m.toolCalls
          .map((tc) => `<tool_call>${JSON.stringify({ name: tc.name, arguments: tc.arguments || {} })}</tool_call>`)
          .join('\n');
        out.push({ role: 'assistant', content: [m.content || '', tags].filter(Boolean).join('\n') });
      } else {
        out.push({ role: 'assistant', content: String(m.content || '') });
      }
    } else if (m.role === 'tool') {
      if (promptToolMode) {
        out.push({
          role: 'user',
          content: formatPromptToolResult(m.toolCallId || 'tc', m.toolName || 'tool', String(m.content || '')),
        });
      } else {
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId || `call_${crypto.randomBytes(4).toString('hex')}`,
          content: String(m.content || ''),
        });
      }
    }
  }
  return out;
}

async function runOpenAiStream({ provider, model, systemPrompt, messages, tools, promptToolMode, stripImages = false, signal, onText, onReasoning }) {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  const fullSystem = promptToolMode && tools?.length
    ? `${systemPrompt}\n\n${buildPromptToolsInstructions(tools)}`
    : systemPrompt;

  const body = {
    model,
    messages: buildOpenAiMessages(fullSystem, messages, promptToolMode, stripImages),
    stream: true,
  };
  if (!promptToolMode && tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
  }

  const headers = {
    'Content-Type': 'application/json',
    ...(provider.extraHeaders || {}),
  };
  if (provider.effectiveApiKey) {
    headers.Authorization = `Bearer ${provider.effectiveApiKey}`;
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let msg = raw;
    try {
      const parsed = JSON.parse(raw);
      msg = parsed?.error?.message || parsed?.message || raw;
    } catch { /* ignore */ }
    throw makeProviderError(res.status, msg, raw);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json();
    const choice = data.choices?.[0];
    let content = choice?.message?.content || '';
    const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
    if (reasoning && onReasoning) onReasoning(reasoning);
    let toolCalls = (choice?.message?.tool_calls || []).map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = { _raw: tc.function?.arguments }; }
      return {
        id: tc.id || `call_${crypto.randomBytes(4).toString('hex')}`,
        name: tc.function?.name || '',
        arguments: args,
      };
    });
    if (promptToolMode) {
      const parsed = parsePromptToolCalls(content);
      content = parsed.cleanText;
      toolCalls = parsed.toolCalls;
    }
    if (content && onText) onText(content);
    return { content, reasoning, toolCalls, usage: data.usage || null, stopReason: choice?.finish_reason || 'stop' };
  }

  let content = '';
  let reasoning = '';
  let stopReason = 'stop';
  let usage = null;
  const toolAcc = new Map();

  for await (const ev of readSseEvents(res.body, signal)) {
    if (ev.data === '[DONE]') break;
    let parsed;
    try { parsed = JSON.parse(ev.data); } catch { continue; }
    if (parsed.error) {
      const eMsg = parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
      throw makeProviderError(parsed.error?.status || 502, eMsg, ev.data);
    }
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) stopReason = choice.finish_reason;
    const delta = choice.delta || {};

    const rChunk = delta.reasoning_content || delta.reasoning || '';
    if (rChunk) {
      reasoning += rChunk;
      if (onReasoning) onReasoning(rChunk);
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      if (!promptToolMode && onText) onText(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (let i = 0; i < delta.tool_calls.length; i++) {
        const tc = delta.tool_calls[i];
        const idx = tc.index !== undefined && tc.index !== null ? tc.index : i;
        if (!toolAcc.has(idx)) {
          toolAcc.set(idx, {
            id: tc.id || `call_${crypto.randomBytes(4).toString('hex')}`,
            name: '',
            argumentsStr: '',
            argumentsObj: null,
          });
        }
        const entry = toolAcc.get(idx);
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') {
          entry.argumentsStr += tc.function.arguments;
        } else if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
          entry.argumentsObj = tc.function.arguments;
        }
      }
    }
  }

  let toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => {
      let args = tc.argumentsObj || {};
      if (!tc.argumentsObj) {
        try { args = tc.argumentsStr ? JSON.parse(tc.argumentsStr) : {}; }
        catch { args = { _raw: tc.argumentsStr }; }
      }
      return { id: tc.id, name: tc.name, arguments: args };
    });

  if (promptToolMode) {
    const parsed = parsePromptToolCalls(content);
    content = parsed.cleanText;
    toolCalls = parsed.toolCalls;
    if (content && onText) onText(content);
  }

  return { content, reasoning, toolCalls, usage, stopReason };
}

export async function streamOpenAiCompat(params) {
  const { provider, model, tools } = params;
  const cacheKey = `${provider.id}::${model}`;
  const mode = provider.toolMode || 'auto';
  const hasTools = Array.isArray(tools) && tools.length > 0;
  let usePromptMode = hasTools && (mode === 'prompt' || (mode === 'auto' && promptFallbackCache.has(cacheKey)));
  let stripImages = textOnlyImageFallbackCache.has(cacheKey);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runOpenAiStream({ ...params, promptToolMode: usePromptMode, stripImages });
    } catch (err) {
      if (mode === 'auto' && hasTools && !usePromptMode && err.isToolsUnsupported) {
        promptFallbackCache.add(cacheKey);
        usePromptMode = true;
        continue;
      }
      if (!stripImages && err.isImagesUnsupported) {
        textOnlyImageFallbackCache.add(cacheKey);
        stripImages = true;
        continue;
      }
      throw err;
    }
  }
}

export async function listOpenAiModels(provider, signal) {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  const headers = { ...(provider.extraHeaders || {}) };
  if (provider.effectiveApiKey) {
    headers.Authorization = `Bearer ${provider.effectiveApiKey}`;
  }
  const res = await fetch(`${baseUrl}/models`, { headers, signal });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw makeProviderError(res.status, raw || `HTTP ${res.status}`, raw);
  }
  const json = await res.json();
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}
