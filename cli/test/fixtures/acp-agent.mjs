import readline from 'node:readline';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const [log, mode = 'ok'] = process.argv.slice(2);
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let session, pending, activeMode = 'unsafe';
const modeState = () => mode === 'absent-modes' ? {} : { modes: { currentModeId: 'unsafe', availableModes: [{ id: 'unsafe', name: 'Unsafe global default' }, { id: mode === 'unsupported-mode' ? 'other' : 'ask', name: 'Ask' }] }, configOptions: [{ id: 'permission_mode', category: 'mode', currentValue: 'unsafe' }] };
const update = value => send({ method: 'session/update', params: { sessionId: session, update: value } });
const secret = 'PRIVATE-STDERR-credential-example';
fs.appendFileSync(log, JSON.stringify({ pid: process.pid }) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
	const m = JSON.parse(line); fs.appendFileSync(log, JSON.stringify(m) + '\n');
	if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: mode === 'v2' ? 2 : 1, agentCapabilities: { loadSession: mode !== 'no-load' } } });
	else if (m.method === 'session/new') {
		if (mode === 'new-error') { send({ id: m.id, error: { code: -32603, message: secret } }); continue; }
		session = randomUUID(); send({ id: m.id, result: { sessionId: session, ...modeState() } });
	}
	else if (m.method === 'session/load') {
		session = m.params.sessionId;
		send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PRIVATE REPLAY' } } } });
		if (mode === 'missing') send({ id: m.id, error: { code: -32602, message: 'raw secret diagnostic' } });
		else send({ id: m.id, result: modeState() });
	} else if (m.method === 'session/set_mode') {
		if (mode === 'setter-uncertain') { send({ id: m.id, result: { accepted: false } }); continue; }
		if (mode === 'setter-exit') process.exit(0);
		if (mode === 'setter-error') { process.stderr.write(secret); send({ id: m.id, error: { code: -32603, message: secret } }); continue; }
		activeMode = m.params.modeId;
		if (mode === 'setter-conflict') update({ sessionUpdate: 'current_mode_update', currentModeId: 'unsafe' });
		else update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'permission_mode', category: 'mode', currentValue: activeMode }] });
		send({ id: m.id, result: {} });
		if (mode === 'idle-conflict') setTimeout(() => update({ sessionUpdate: 'current_mode_update', currentModeId: 'unsafe' }), 100);
	} else if (m.method === 'session/prompt') {
		const text = m.params.prompt.map(p => p.text).join(''); pending = m.id;
		if (activeMode !== 'ask') throw new Error('fixture received unsafe prompt');
		if (text === 'prompt-error') { process.stderr.write(secret); send({ id: m.id, error: { code: 400, message: secret, data: { error: secret } } }); continue; }
		if (text === 'stderr') process.stderr.write(secret.repeat(100000));
		if (text === 'mode-change' || text === 'config-change') { update(text === 'mode-change' ? { sessionUpdate: 'current_mode_update', currentModeId: 'unsafe' } : { sessionUpdate: 'config_option_update', configOptions: [{ id: 'permission_mode', currentValue: 'unsafe' }] }); continue; }
		if (text === 'foreign-change') send({ method: 'session/update', params: { sessionId: 'another-session', update: { sessionUpdate: 'current_mode_update', currentModeId: 'unsafe' } } });
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
		const chunks = text === 'messages' ? [['a', 'hel'], ['a', 'lo'], ['b', 'wor'], ['b', 'ld'], ['c', 'final artifact']] : text === 'mixed-ids' ? [['a', 'one'], [undefined, 'two'], ['b', 'three']] : [[undefined, 'hello '], [undefined, text]];
		for (const [messageId, chunk] of chunks) update({ sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}), content: { type: 'text', text: chunk } });
		send({ id: m.id, result: { stopReason: 'end_turn' } }); pending = null;
	} else if (m.method === 'session/cancel' && pending) { send({ id: pending, result: { stopReason: 'cancelled' } }); pending = null; }
}
