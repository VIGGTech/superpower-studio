import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  buildPromptToolsInstructions,
  parsePromptToolCalls,
} from '../lib/providers/prompt-tools.mjs';
import {
  streamChat,
  listProviderModels,
  testProviderConnection,
} from '../lib/providers/index.mjs';

const SAMPLE_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

async function withMockServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

test('prompt-tools parses single, multiple, and markdown-fenced <tool_call> tags cleanly', () => {
  const inst = buildPromptToolsInstructions(SAMPLE_TOOLS);
  assert.match(inst, /<tool_call>/);
  assert.match(inst, /read_file/);

  const raw = [
    'Let me inspect both files.',
    '```xml',
    '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>',
    '```',
    '<tool_call>{"name":"read_file","arguments":{"path":"b.txt"}}</tool_call>',
    '<tool_call>{bad json</tool_call>',
  ].join('\n');

  const parsed = parsePromptToolCalls(raw);
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].name, 'read_file');
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: 'a.txt' });
  assert.deepEqual(parsed.toolCalls[1].arguments, { path: 'b.txt' });
  assert.ok(!parsed.cleanText.includes('<tool_call>'));
  assert.match(parsed.cleanText, /Let me inspect both files/);
});

test('openai-compatible streams content, reasoning_content, tool_calls, and lists models', async () => {
  await withMockServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'abliterated-70b' }, { id: 'deepseek-r1' }] }));
      return;
    }
    const body = JSON.parse(await readBody(req));
    assert.equal(req.headers.authorization, 'Bearer ak_test');
    assert.equal(body.model, 'abliterated-70b');
    assert.equal(body.stream, true);

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { choices: [{ delta: { reasoning_content: 'Thinking...' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Checking ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'file.' }, finish_reason: null }] },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ];
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }, async (baseUrl) => {
    const provider = {
      id: 'abliteration-test',
      name: 'Abliteration Test',
      kind: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      effectiveApiKey: 'ak_test',
      toolMode: 'native',
      extraHeaders: {},
    };
    const models = await listProviderModels(provider);
    assert.deepEqual(models, ['abliterated-70b', 'deepseek-r1']);

    const conn = await testProviderConnection(provider);
    assert.equal(conn.ok, true);
    assert.equal(conn.modelsCount, 2);

    const texts = [];
    const reasonings = [];
    const result = await streamChat({
      provider,
      model: 'abliterated-70b',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: SAMPLE_TOOLS,
      onText: (t) => texts.push(t),
      onReasoning: (r) => reasonings.push(r),
    });
    assert.equal(result.content, 'Checking file.');
    assert.equal(result.reasoning, 'Thinking...');
    assert.equal(texts.join(''), 'Checking file.');
    assert.equal(reasonings.join(''), 'Thinking...');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'README.md' });
  });
});

test('openai-compatible toolMode=auto retries transparently in prompt mode on HTTP 400 tools unsupported', async () => {
  let attempts = 0;
  await withMockServer(async (req, res) => {
    attempts++;
    const body = JSON.parse(await readBody(req));
    if (body.tools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This model does not support tools or function calling' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const msg = 'Opening file.\n<tool_call>{"name":"read_file","arguments":{"path":"x.txt"}}</tool_call>';
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: msg }, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }, async (baseUrl) => {
    const provider = {
      id: 'ablit-auto-fallback',
      name: 'Ablit Auto',
      kind: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      effectiveApiKey: 'ak_1',
      toolMode: 'auto',
      extraHeaders: {},
    };
    const res1 = await streamChat({
      provider,
      model: 'bare-abliterated',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Read x.txt' }],
      tools: SAMPLE_TOOLS,
    });
    assert.equal(attempts, 2);
    assert.equal(res1.toolCalls.length, 1);
    assert.deepEqual(res1.toolCalls[0].arguments, { path: 'x.txt' });

    // Second call should hit cached prompt mode directly (only 1 attempt)
    const res2 = await streamChat({
      provider,
      model: 'bare-abliterated',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Read x.txt again' }],
      tools: SAMPLE_TOOLS,
    });
    assert.equal(attempts, 3);
    assert.equal(res2.toolCalls.length, 1);
  });
});

test('anthropic adapter streams text, thinking, and tool_use blocks', async () => {
  await withMockServer(async (req, res) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'ant_key');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(await readBody(req));
    assert.equal(body.model, 'claude-sonnet-4-5');

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = [
      ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Plan...' } }],
      ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello Claude' } }],
      ['content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } }],
      ['content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.js"}' } }],
      ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } }],
      ['message_stop', {}],
    ];
    for (const [ev, data] of events) {
      res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    res.end();
  }, async (baseUrl) => {
    const result = await streamChat({
      provider: { id: 'anthropic', name: 'Claude', kind: 'anthropic', baseUrl, effectiveApiKey: 'ant_key', toolMode: 'native' },
      model: 'claude-sonnet-4-5',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: SAMPLE_TOOLS,
    });
    assert.equal(result.content, 'Hello Claude');
    assert.equal(result.reasoning, 'Plan...');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'toolu_1');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.js' });
  });
});

test('gemini adapter streams text, thoughts, and functionCall parts', async () => {
  await withMockServer(async (req, res) => {
    assert.match(req.url, /\/models\/gemini-2\.5-pro:streamGenerateContent\?alt=sse/);
    assert.equal(req.headers['x-goog-api-key'], 'gem_key');
    const body = JSON.parse(await readBody(req));
    assert.ok(body.tools[0].functionDeclarations.length === 1);

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'Analyzing...', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Hello Gemini' }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'g.md' } } }] }, finishReason: 'STOP' }] },
    ];
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.end();
  }, async (baseUrl) => {
    const result = await streamChat({
      provider: { id: 'gemini', name: 'Gemini', kind: 'gemini', baseUrl, effectiveApiKey: 'gem_key', toolMode: 'native' },
      model: 'gemini-2.5-pro',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: SAMPLE_TOOLS,
    });
    assert.equal(result.content, 'Hello Gemini');
    assert.equal(result.reasoning, 'Analyzing...');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'g.md' });
  });
});

test('provider layer retries transient 429 and normalizes context overflow errors', async () => {
  let calls = 0;
  await withMockServer(async (req, res) => {
    calls++;
    const body = JSON.parse(await readBody(req));
    if (body.model === 'rate-limited' && calls === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
      return;
    }
    if (body.model === 'overflow-model') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'This model maximum context length is 8192 tokens' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Recovered' }, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }, async (baseUrl) => {
    const provider = {
      id: 'retry-test',
      name: 'Retry',
      kind: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      effectiveApiKey: 'k',
      toolMode: 'native',
    };
    const ok = await streamChat({
      provider,
      model: 'rate-limited',
      systemPrompt: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      retryBaseDelayMs: 10,
    });
    assert.equal(ok.content, 'Recovered');
    assert.equal(calls, 2);

    await assert.rejects(
      () => streamChat({
        provider,
        model: 'overflow-model',
        systemPrompt: 'Sys',
        messages: [{ role: 'user', content: 'Too long' }],
        tools: [],
        retryBaseDelayMs: 10,
      }),
      (err) => err.isContextOverflow === true
    );
  });
});
