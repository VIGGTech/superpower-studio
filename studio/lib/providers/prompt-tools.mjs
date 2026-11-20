import crypto from 'node:crypto';

export function buildPromptToolsInstructions(tools) {
  if (!tools || tools.length === 0) return '';
  const specs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || { type: 'object', properties: {} },
  }));
  return [
    '# Tool Calling Protocol',
    'You have access to the following tools. To invoke a tool, emit one or more XML blocks in this exact format:',
    '<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>',
    'Wait for the corresponding <tool_result> before claiming tool output. Available tools:',
    '```json',
    JSON.stringify(specs, null, 2),
    '```',
  ].join('\n');
}

export function formatPromptToolResult(toolCallId, name, resultText) {
  return `<tool_result id="${toolCallId}" name="${name}">\n${resultText}\n</tool_result>`;
}

export function parsePromptToolCalls(text) {
  if (!text) return { cleanText: '', toolCalls: [] };
  const toolCalls = [];
  const regex = /(?:```[a-zA-Z]*\r?\n)?<tool_call>([\s\S]*?)<\/tool_call>(?:\r?\n```)?/g;
  const cleanText = text.replace(regex, (_match, inner) => {
    const trimmed = String(inner || '').trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.name === 'string') {
        let args = {};
        if (parsed.arguments && typeof parsed.arguments === 'object') {
          args = parsed.arguments;
        } else if (typeof parsed.arguments === 'string') {
          try {
            const innerArgs = JSON.parse(parsed.arguments);
            if (innerArgs && typeof innerArgs === 'object') args = innerArgs;
          } catch { /* ignore */ }
        }
        toolCalls.push({
          id: `ptc_${crypto.randomBytes(4).toString('hex')}`,
          name: parsed.name,
          arguments: args,
        });
      }
    } catch {
      // Ignore malformed JSON tool_call blocks safely
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, toolCalls };
}
