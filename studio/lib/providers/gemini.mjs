import crypto from 'node:crypto';
import { makeProviderError, readSseEvents } from './openai-compat.mjs';

function buildGeminiContents(messages) {
  const contents = [];
  const pushRolePart = (role, parts) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts: [...parts] });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const parts = [];
      const textParts = [String(m.content || '')];
      for (const att of m.hydratedAttachments || []) {
        if (att.mimeType === 'image/svg+xml' && att.svgText) {
          textParts.push(`\n[Attached SVG: ${att.filename} (id: ${att.id})]\n\`\`\`xml\n${att.svgText.slice(0, 12000)}\n\`\`\``);
        } else if (att.base64) {
          textParts.push(`\n[Attached image: ${att.filename} (id: ${att.id})]`);
          parts.push({ inlineData: { mimeType: att.mimeType, data: att.base64 } });
        }
      }
      const txt = textParts.join('\n').trim();
      if (txt || parts.length === 0) {
        parts.unshift({ text: txt || ' ' });
      }
      pushRolePart('user', parts);
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          const fc = {
            name: tc.name,
            args: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {},
          };
          if (tc.id && !String(tc.id).startsWith('gfc_')) fc.id = tc.id;
          const part = { functionCall: fc };
          if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
          parts.push(part);
        }
      }
      if (parts.length === 0) parts.push({ text: ' ' });
      pushRolePart('model', parts);
    } else if (m.role === 'tool') {
      const fr = {
        name: m.toolName || 'tool',
        response: { output: String(m.content || '') },
      };
      if (m.toolCallId && !String(m.toolCallId).startsWith('gfc_')) fr.id = m.toolCallId;
      pushRolePart('user', [{ functionResponse: fr }]);
    }
  }
  return contents;
}

export async function streamGemini({ provider, model, systemPrompt, messages, tools, signal, onText, onReasoning }) {
  const baseUrl = String(provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const cleanModel = String(model || '').replace(/^models\//, '');
  const endpoint = `${baseUrl}/models/${encodeURIComponent(cleanModel)}:streamGenerateContent?alt=sse`;

  const body = {
    contents: buildGeminiContents(messages),
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (tools && tools.length > 0) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      })),
    }];
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': provider.effectiveApiKey || '',
      ...(provider.extraHeaders || {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let msg = raw;
    try {
      const parsed = JSON.parse(raw);
      msg = parsed?.error?.message || raw;
    } catch { /* ignore */ }
    throw makeProviderError(res.status, msg, raw);
  }

  let content = '';
  let reasoning = '';
  let stopReason = 'STOP';
  let usage = null;
  const toolCalls = [];

  for await (const ev of readSseEvents(res.body, signal)) {
    let data;
    try { data = JSON.parse(ev.data); } catch { continue; }
    if (data.usageMetadata) usage = data.usageMetadata;
    const cand = data.candidates?.[0];
    if (!cand) continue;
    if (cand.finishReason) stopReason = cand.finishReason;
    for (const part of cand.content?.parts || []) {
      if (part.thought && part.text) {
        reasoning += part.text;
        if (onReasoning) onReasoning(part.text);
      } else if (typeof part.text === 'string' && part.text.length > 0) {
        content += part.text;
        if (onText) onText(part.text);
      } else if (part.functionCall) {
        const call = {
          id: part.functionCall.id || `gfc_${crypto.randomBytes(4).toString('hex')}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args && typeof part.functionCall.args === 'object'
            ? part.functionCall.args
            : {},
        };
        if (part.thoughtSignature) call.thoughtSignature = part.thoughtSignature;
        toolCalls.push(call);
      }
    }
  }

  return { content, reasoning, toolCalls, usage, stopReason };
}

export async function listGeminiModels(provider, signal) {
  const baseUrl = String(provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/models`, {
    headers: {
      'x-goog-api-key': provider.effectiveApiKey || '',
      ...(provider.extraHeaders || {}),
    },
    signal,
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw makeProviderError(res.status, raw || `HTTP ${res.status}`, raw);
  }
  const json = await res.json();
  return (json.models || [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean);
}
