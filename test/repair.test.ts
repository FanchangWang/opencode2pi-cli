import { expect, test } from 'bun:test';

import { Backend, type CatalogModel, type CompletionMeta } from '../src/backend.ts';
import { prepare, type ChatBody, type FunctionTool } from '../src/protocol.ts';
import { rawMaterial, repairBody } from '../src/repair.ts';

const tools: FunctionTool[] = [{ type: 'function', function: { name: 'Write', description: 'Write the complete file. The path may be relative to the external workspace.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } }];

test('repair receives intact long Write material, conversation and receiver descriptions', () => {
  // Sizes and camelCase field mirror a retained Write failure; no user file content.
  const content = 'x'.repeat(46649);
  const call = { name: 'Write', arguments: { filePath: '/external/slides.html', content } };
  const conversation = [{ role: 'user', content: 'Use /external as the workspace.' }, ...Array.from({ length: 7 }, () => ({ role: 'assistant', content: 'working' })),
    { role: 'assistant', content: null, tool_calls: [{ id: 'previous', type: 'function', function: { name: 'Write', arguments: JSON.stringify(call.arguments) } }] },
    { role: 'tool', tool_call_id: 'previous', content: 'Write error: file_path expected string, received undefined' }];
  const response = { info: { finish: 'length' }, parts: [{ type: 'tool', tool: 'StructuredOutput', state: { status: 'completed', input: { content: '', calls: [call] } } }] };
  const material = rawMaterial(response, { text: JSON.stringify(conversation) });
  const sent = JSON.parse(repairBody({ shape: 'envelope', tools, material })) as {
    material: { parts: { state: { input: { calls: unknown[] } } }[]; conversation: unknown[] };
    tools: { description?: string }[];
  };
  expect(sent.material.parts[0]!.state.input.calls[0]).toEqual(call);
  expect(sent.material.conversation).toEqual(conversation);
  expect(sent.tools[0]!.description).toBe(tools[0]!.function.description);
});

/** Drive the v1 completion path with a scripted OpenCode, so no server is involved. */
function scriptedBackend(script: (route: string, payload: Record<string, unknown> | undefined) => unknown): Backend {
  const backend = new Backend('http://unused', 'test', undefined);
  backend.translator = () => 'oc-translator';
  backend.request = async (route: string, _method?: string, payload?: unknown) => script(route, payload as Record<string, unknown> | undefined);
  return backend;
}

test('translation can explicitly decline incomplete material and return control to the original model', async () => {
  const models: CatalogModel[] = [{ id: 'oc-test', name: 'test' }];
  const body: ChatBody = { model: models[0]!.id, tools, messages: [{ role: 'user', content: 'Write the file.' }] };
  const request = prepare(body, models);
  let sessions = 0, turns = 0;
  const sent: string[] = [];
  const backend = scriptedBackend((route, payload) => {
    if (route === '/session') return { id: `s${sessions++}` };
    if (route.endsWith('/message')) {
      const parts = (payload?.parts ?? []) as { type: string; text?: string }[];
      if (route.startsWith('/session/s0/')) sent.push(parts[0]!.text ?? '');
      if (route.startsWith('/session/s1/')) return { parts: [{ type: 'text', text: '{"unrepairable":true,"reason":"Write.content is missing; resend the complete file body."}' }] };
      turns++;
      if (turns < 3) return { info: { structured: { content: 5, calls: [] } }, parts: [] };
      return { info: { structured: { content: '', calls: [{ name: 'Write', arguments: { file_path: '/external/file', content: 'complete' } }] } }, parts: [] };
    }
    return [];
  });
  const meta: CompletionMeta = {};
  const result = await backend.complete(request, undefined, meta);
  expect(turns).toBe(3);
  expect(sent.at(-1)).toMatch(/Write.content is missing/);
  expect(meta.repaired?.envelope?.reason).toBe('insufficient material');
  expect(result.choices[0]!.message.tool_calls![0]!.function.name).toBe('Write');
});

test('a blocked action that cannot be repaired asks the original model for the missing detail', async () => {
  const models: CatalogModel[] = [{ id: 'oc-test', name: 'test' }];
  const body: ChatBody = { model: models[0]!.id, tools, messages: [{ role: 'user', content: 'Write the complete file.' }] };
  const request = prepare(body, models);
  let sessions = 0, turns = 0, permission = true;
  const sent: string[] = [];
  const backend = scriptedBackend((route, payload) => {
    if (route === '/session') return { id: `s${sessions++}` };
    if (route === '/permission') {
      if (!permission) return [];
      permission = false;
      return [{ id: 'p', sessionID: 's0', tool: { callID: 'missing' } }];
    }
    if (route.endsWith('/message')) {
      const parts = (payload?.parts ?? []) as { type: string; text?: string }[];
      if (route.startsWith('/session/s1/')) return { parts: [{ type: 'text', text: '{"unrepairable":true,"reason":"Write.content is missing; resend full content."}' }] };
      turns++; sent.push(parts[0]!.text ?? '');
      return { info: { structured: turns === 1 ? { content: 'Writing next.', calls: [] }
        : { content: '', calls: [{ name: 'Write', arguments: { file_path: '/external/file', content: 'complete' } }] } }, parts: [] };
    }
    return [];
  });
  backend.toolParts.set('missing', { tool: 'write', input: { filePath: '/external/file' } });
  const result = await backend.complete(request, undefined, {});
  expect(turns).toBe(2);
  expect(sent[1]).toMatch(/Write.content is missing/);
  expect(result.choices[0]!.message.tool_calls![0]!.function.name).toBe('Write');
});