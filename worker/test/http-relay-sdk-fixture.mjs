import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as sdk from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';

export async function startFixture() {
  const a = 'fixture-app-' + randomBytes(32).toString('hex');
  const b = 'fixture-app-' + randomBytes(32).toString('hex');
  const auth = new Map([[`Bearer ${a}`, 'a'], [`Bearer ${b}`, 'b']]);
  const state = { received: [], streamStarted: 0, streamFinished: 0, streamAborted: 0, tasks: new Map() };
  let base;
  const taskJson = (task, legacy) => legacy ? { kind: 'task', id: task.id, contextId: task.contextId, status: { state: task.state } } : sdk.Task.toJSON(sdk.Task.fromJSON({ id: task.id, contextId: task.contextId, status: { state: task.state === 'canceled' ? sdk.TaskState.TASK_STATE_CANCELED : task.state === 'completed' ? sdk.TaskState.TASK_STATE_COMPLETED : sdk.TaskState.TASK_STATE_WORKING } }));
  const card = (legacy) => ({ name: 'SDK fixture', description: 'Private origin http://127.0.0.1:9000 and fixture.ts.net must not leak', version: '1.0', defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'echo', name: 'Echo', description: 'Fixture only', tags: ['test'] }], capabilities: { streaming: true, pushNotifications: false }, ...(legacy ? { protocolVersion: '0.3.0', preferredTransport: 'JSONRPC', url: base + '/rpc', securitySchemes: { app: { type: 'http', scheme: 'bearer' } }, security: [{ app: [] }] } : { supportedInterfaces: ['1.0','0.3'].map(protocolVersion => ({ url: base + '/rpc', protocolBinding: 'JSONRPC', protocolVersion })), securitySchemes: { app: { httpAuthSecurityScheme: { scheme: 'bearer' } } }, securityRequirements: [{ schemes: { app: { list: [] } } }] }) });
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card(false))); return; }
      if (req.method === 'GET' && req.url === '/.well-known/agent.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card(true))); return; }
      if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404).end(); return; }
      const chunks = []; for await (const c of req) chunks.push(c);
      const bytes = Buffer.concat(chunks); const input = JSON.parse(bytes);
      const who = auth.get(req.headers.authorization);
      state.received.push({ bytes, input, who });
      if (!who) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'application authentication required' })); return; }
      const legacy = input.method.includes('/');
      const send = ['SendMessage','message/send'].includes(input.method);
      const stream = ['SendStreamingMessage','message/stream'].includes(input.method);
      const get = ['GetTask','tasks/get'].includes(input.method);
      const cancel = ['CancelTask','tasks/cancel'].includes(input.method);
      const reply = (result, error) => { const output = { jsonrpc: '2.0', id: input.id, ...(error ? { error } : { result }) }; res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(output)); };
      if (send || stream) {
        const task = { id: input.params.message.messageId, contextId: `context-${who}`, owner: who, state: 'working' };
        state.tasks.set(task.id, task);
        if (send) { reply(legacy ? taskJson(task, true) : { task: taskJson(task, false) }); return; }
        state.streamStarted++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const event = result => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: input.id, result })}\n\n`);
        event(legacy ? taskJson(task, true) : { task: taskJson(task, false) });
        const timer = setTimeout(() => {
          if (res.destroyed) return;
          task.state = 'completed'; state.streamFinished++;
          event(legacy ? { kind: 'status-update', taskId: task.id, contextId: task.contextId, status: { state: 'completed' }, final: true } : { statusUpdate: { taskId: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_COMPLETED' } } });
          res.end();
        }, 600);
        res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) state.streamAborted++; });
        return;
      }
      if (get || cancel) {
        const id = input.params.id ?? String(input.params.name || '').replace(/^tasks\//, '');
        const task = state.tasks.get(id);
        if (!task || task.owner !== who) { reply(undefined, { code: -32001, message: 'Task not found' }); return; }
        if (cancel) task.state = 'canceled';
        reply(taskJson(task, legacy)); return;
      }
      reply(undefined, { code: -32601, message: 'Method not found' });
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, a, b, state, card, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export async function exerciseSDK({ base, fetchImpl = fetch, fixture, versions = [false, true], onStep = (_step) => {} }) {
  const receipts = [];
  for (const legacy of versions) {
    const version = legacy ? '0.3' : '1.0';
    const wrap = secret => async (input, init) => { const req = new Request(input, init); const headers = new Headers(req.headers); headers.set('authorization', `Bearer ${secret}`); return fetchImpl(new Request(req, { headers })); };
    const make = async secret => {
      const customFetch = wrap(secret);
      return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: customFetch, legacyCompat: { enabled: true } })], cardResolver: new DefaultAgentCardResolver({ fetchImpl: customFetch, legacyCompat: { enabled: true } }) }).createFromUrl(base + '/.well-known/' + (legacy ? 'agent.json' : 'agent-card.json'), '');
    };
    const client = await make(fixture.a); const other = await make(fixture.b);
    const message = id => sdk.SendMessageRequest.fromJSON({ message: { messageId: id, role: sdk.Role.ROLE_USER, parts: [{ text: 'real SDK proof' }] } });
    const id = `sdk-${version}-send`;
    const sent = await client.sendMessage(message(id));
    assert.equal(sent.task?.id ?? sent.payload?.value?.id ?? sent.id, id, 'SDK receives original native task identity');
    const got = await client.getTask(sdk.GetTaskRequest.fromJSON({ id })); assert.equal(got.id, id);
    await assert.rejects(other.getTask(sdk.GetTaskRequest.fromJSON({ id })), /not found/i, 'native application enforces per-caller task isolation');
    const canceled = await client.cancelTask(sdk.CancelTaskRequest.fromJSON({ id })); assert.equal(canceled.status.state, sdk.TaskState.TASK_STATE_CANCELED);
    onStep('discovery/send/get/cancel/cross-caller-denial passed');
    const before = fixture.state.streamFinished;
    let events = 0;
    for await (const event of client.sendMessageStream(message(`sdk-${version}-stream`))) {
      assert.ok(event.payload, 'SDK decoded a real SSE event'); events++;
      if (events === 1) assert.equal(fixture.state.streamFinished, before, 'first SSE event arrives before receiver finishes');
    }
    assert.equal(events, 2); assert.equal(fixture.state.streamFinished, before + 1);
    onStep('incremental two-event SSE passed');
    const controller = new AbortController();
    const abortedBefore = fixture.state.streamAborted;
    const iterator = client.sendMessageStream(message(`sdk-${version}-abort`), { signal: controller.signal });
    assert.equal((await iterator.next()).done, false); controller.abort();
    try { await iterator.next(); } catch (e) { assert.match(String(e), /abort/i); }
    const deadline = Date.now() + 2500;
    while (fixture.state.streamAborted === abortedBefore && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(fixture.state.streamAborted, abortedBefore + 1, 'public abort reaches native receiver before final event');
    receipts.push({ protocol: version, discovery: 'pass', send: 'pass', get: 'pass', cancel: 'pass', crossCallerTaskDenied: 'pass', incrementalSSE: events, abortPropagated: 'pass' });
  }
  return receipts;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const fixture = await startFixture();
  try { console.log(JSON.stringify({ mode: 'direct-fixture-baseline-NOT-relay-proof', sdk: '@a2a-js/sdk@1.3.0', receipts: await exerciseSDK({ base: fixture.base, fixture }) })); }
  finally { await fixture.close(); }
}
