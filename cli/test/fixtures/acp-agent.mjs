import readline from 'node:readline';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const [log, mode = 'ok'] = process.argv.slice(2);
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let session, pending;
fs.appendFileSync(log, JSON.stringify({ pid: process.pid }) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
	const m = JSON.parse(line); fs.appendFileSync(log, JSON.stringify(m) + '\n');
	if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: mode === 'v2' ? 2 : 1, agentCapabilities: { loadSession: mode !== 'no-load' } } });
	else if (m.method === 'session/new') { session = randomUUID(); send({ id: m.id, result: { sessionId: session } }); }
	else if (m.method === 'session/load') {
		session = m.params.sessionId;
		send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PRIVATE REPLAY' } } } });
		if (mode === 'missing') send({ id: m.id, error: { code: -32602, message: 'raw secret diagnostic' } });
		else send({ id: m.id, result: {} });
	} else if (m.method === 'session/prompt') {
		const text = m.params.prompt.map(p => p.text).join(''); pending = m.id;
		if (text === 'hang') continue;
		if (text === 'malformed') { process.stdout.write('not-json\n'); continue; }
		if (text === 'huge') { process.stdout.write('x'.repeat(262145)); continue; }
		if (text === 'permission') { send({ id: 'permission', method: 'session/request_permission', params: { sessionId: session, options: [{ optionId: 'yes', kind: 'allow_always' }] } }); continue; }
		if (text === 'capability') send({ id: 'fs', method: 'fs/read_text_file', params: { path: '/must-not-read' } });
		if (text === 'overflow' || text === 'flood') {
			for (let i = 0; i < (text === 'flood' ? 1030 : 10); i++) send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text === 'flood' ? 'x' : 'x'.repeat(65536) } } } });
			continue;
		}
		send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE THOUGHT' } } } });
		for (const chunk of ['hello ', text]) send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } } });
		send({ id: m.id, result: { stopReason: 'end_turn' } }); pending = null;
	} else if (m.method === 'session/cancel' && pending) { send({ id: pending, result: { stopReason: 'cancelled' } }); pending = null; }
}
