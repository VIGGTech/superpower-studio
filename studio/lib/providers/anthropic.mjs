import crypto from 'node:crypto';
import { makeProviderError, readSseEvents } from './openai-compat.mjs';

function buildAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const blocks = [];
      const textParts = [String(m.content || '')];
      for (const att of m.hydratedAttachments || []) {
        if (att.mimeType === 'image/svg+xml' && att.svgText) {
          textParts.push(`\n[Attached SVG: ${att.filename} (id: ${att.id})]\n\`\`\`xml\n${att.svgText.slice(0, 12000)}\n\`\`\``);
        } else if (att.base64) {
          textParts.push(`\n[Attached image: ${att.filename} (id: ${att.id})]`);
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: att.mimeType, data: att.base64 },
          });
        }
      }
      const txt = textParts.join('\n').trim();
      if (txt || blocks.length === 0) {
        blocks.unshift({ type: 'text', text: txt || ' ' });
      }
      const last = out[out.length - 1];
      if (last && last.role === 'user') {
        last.content.push(...blocks);
      } else {
        out.push({ role: 'user', content: blocks });
      }
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {},
          });
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: ' ' });
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId || `toolu_${crypto.randomBytes(4).toString('hex')}`,
        content: String(m.content || ''),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

export async function streamAnthropic({ provider, model, systemPrompt, messages, tools, signal, onText, onReasoning }) {
  const baseUrl = String(provider.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/v1') ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;

  const body = {
    model,
    max_tokens: 8192,
    system: systemPrompt || undefined,
    messages: buildAnthropicMessages(messages),
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.effectiveApiKey || '',
      'anthropic-version': '2023-06-01',
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
  let stopReason = 'end_turn';
  let usage = null;
  const blocks = new Map();

  for await (const ev of readSseEvents(res.body, signal)) {
    let data;
    try { data = JSON.parse(ev.data); } catch { continue; }
    if (ev.event === 'content_block_start') {
      const b = data.content_block || {};
      blocks.set(data.index, {
        type: b.type,
        id: b.id || `toolu_${crypto.randomBytes(4).toString('hex')}`,
        name: b.name || '',
        jsonStr: '',
      });
    } else if (ev.event === 'content_block_delta') {
      const d = data.delta || {};
      if (d.type === 'text_delta' && d.text) {
        content += d.text;
        if (onText) onText(d.text);
      } else if (d.type === 'thinking_delta' && d.thinking) {
        reasoning += d.thinking;
        if (onReasoning) onReasoning(d.thinking);
      } else if (d.type === 'input_json_delta' && d.partial_json) {
        const entry = blocks.get(data.index);
        if (entry) entry.jsonStr += d.partial_json;
      }
    } else if (ev.event === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data.usage) usage = data.usage;
    }
  }

  const toolCalls = [];
  for (const [, b] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (b.type === 'tool_use') {
      let args = {};
      try { args = b.jsonStr ? JSON.parse(b.jsonStr) : {}; } catch { args = { _raw: b.jsonStr }; }
      toolCalls.push({ id: b.id, name: b.name, arguments: args });
    }
  }

  return { content, reasoning, toolCalls, usage, stopReason };
}
