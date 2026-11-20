import { streamOpenAiCompat, listOpenAiModels } from './openai-compat.mjs';
import { streamAnthropic } from './anthropic.mjs';
import { streamGemini, listGeminiModels } from './gemini.mjs';

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function dispatchOnce(params) {
  const { provider } = params;
  if (!provider) throw new Error('Provider configuration is required');
  if (provider.kind === 'anthropic') return streamAnthropic(params);
  if (provider.kind === 'gemini') return streamGemini(params);
  if (provider.kind === 'openai-compatible') return streamOpenAiCompat(params);
  throw new Error(`Unsupported provider kind: ${provider.kind}`);
}

export async function streamChat(params) {
  const maxRetries = params.maxRetries ?? 2;
  const baseDelayMs = params.retryBaseDelayMs ?? 500;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await dispatchOnce(params);
    } catch (err) {
      lastErr = err;
      if (params.signal?.aborted || err.name === 'AbortError' || !err.retryable || attempt === maxRetries) {
        throw err;
      }
      await sleep(baseDelayMs * Math.pow(2, attempt), params.signal);
    }
  }
  throw lastErr;
}

export async function listProviderModels(provider, signal) {
  if (!provider) throw new Error('Provider not found');
  if (provider.kind === 'openai-compatible') {
    return listOpenAiModels(provider, signal);
  }
  if (provider.kind === 'gemini') {
    return listGeminiModels(provider, signal);
  }
  if (provider.kind === 'anthropic') {
    const baseUrl = String(provider.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    const endpoint = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
    try {
      const res = await fetch(endpoint, {
        headers: {
          'x-api-key': provider.effectiveApiKey || '',
          'anthropic-version': '2023-06-01',
          ...(provider.extraHeaders || {}),
        },
        signal,
      });
      if (res.ok) {
        const json = await res.json();
        const ids = (json.data || []).map((m) => m.id).filter(Boolean);
        if (ids.length > 0) return ids;
      }
    } catch { /* fall back to curated defaults */ }
    return provider.models || ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'];
  }
  return provider.models || [];
}

export async function testProviderConnection(provider, model) {
  const start = Date.now();
  try {
    const models = await listProviderModels(provider);
    if (models.length > 0) {
      return {
        ok: true,
        latencyMs: Date.now() - start,
        message: `Connected (${models.length} models discovered)`,
        modelsCount: models.length,
        models: models.slice(0, 50),
      };
    }
    const targetModel = model || provider.defaultModel;
    await streamChat({
      provider,
      model: targetModel,
      systemPrompt: 'Reply with OK.',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      maxRetries: 0,
    });
    return { ok: true, latencyMs: Date.now() - start, message: `Connected via ${targetModel}` };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      message: err.message || 'Connection failed',
    };
  }
}
