/** Bounded ACP v1 stdio client. No shell, filesystem or terminal capabilities. */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const acpLimits = Object.freeze({ lineBytes: 262144, outputBytes: 524288, requestMs: 45000, sessions: 8, tasks: 128 });
const failure = () => new Error('ACP operation failed; check local adapter authentication and protocol compatibility');
export class AcpClient {
	constructor({ command, cwd, onUpdate = () => {}, onPermission = () => {} }) {
		this.pending = new Map(); this.next = 0; this.closed = false; this.cleanup = null;
		this.onUpdate = onUpdate; this.onPermission = onPermission;
		this.child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
		this.exited = new Promise(resolve => { this.child.once('close', resolve); });
		this.child.on('error', () => { void this.close(); });
		this.child.on('exit', () => { void this.close(); });
		this.child.stdin.on('error', () => { void this.close(); });
		// Drain but never log arbitrary diagnostics: providers may include credentials.
		this.child.stderr.on('data', () => {});
		let buffer = '', bytes = 0; const decoder = new StringDecoder('utf8');
		this.child.stdout.on('data', chunk => {
			if (this.closed) return;
			buffer += decoder.write(chunk); bytes += chunk.length;
			if (bytes > acpLimits.lineBytes && !buffer.includes('\n')) { void this.close(); return; }
			let at;
			while ((at = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); bytes = Buffer.byteLength(buffer);
				if (Buffer.byteLength(line) > acpLimits.lineBytes) { void this.close(); return; }
				try { this.receive(JSON.parse(line)); } catch { void this.close(); return; }
			}
			if (bytes > acpLimits.lineBytes) void this.close();
		});
	}
	write(message) {
		if (this.closed || this.child.stdin.writableLength > acpLimits.lineBytes) throw failure();
		const line = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
		if (Buffer.byteLength(line) > acpLimits.lineBytes) throw failure();
		this.child.stdin.write(line);
	}
	receive(m) {
		if (!m || m.jsonrpc !== '2.0' || Array.isArray(m)) throw failure();
		if (typeof m.method === 'string') {
			if (Object.hasOwn(m, 'id')) {
				if (m.method === 'session/request_permission') {
					this.write({ id: m.id, result: { outcome: { outcome: 'cancelled' } } });
					this.onPermission(m.params);
				} else this.write({ id: m.id, error: { code: -32601, message: 'Client capability not supported' } });
			} else if (m.method === 'session/update') this.onUpdate(m.params);
			return;
		}
		const entry = this.pending.get(m.id); if (!entry) throw failure();
		this.pending.delete(m.id); clearTimeout(entry.timer);
		if (Object.hasOwn(m, 'error') || !m.result || typeof m.result !== 'object' || Array.isArray(m.result)) entry.reject(failure());
		else entry.resolve(m.result);
	}
	call(method, params) {
		return new Promise((resolve, reject) => {
			const id = ++this.next;
			const timer = setTimeout(() => { void this.close(); }, acpLimits.requestMs);
			this.pending.set(id, { resolve, reject, timer });
			try { this.write({ id, method, params }); } catch { this.pending.delete(id); clearTimeout(timer); reject(failure()); }
		});
	}
	cancel(sessionId) { try { this.write({ method: 'session/cancel', params: { sessionId } }); } catch { /* teardown is authoritative */ } }
	close() {
		if (this.cleanup) return this.cleanup;
		this.closed = true;
		for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(failure()); } this.pending.clear();
		this.cleanup = (async () => {
			const kill = signal => { try { if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch { /* already exited */ } };
			kill('SIGTERM'); this.child.stdin.destroy();
			const timer = setTimeout(() => kill('SIGKILL'), 500);
			await this.exited; clearTimeout(timer);
			// Descendants can outlive the leader without retaining its pipes.
			kill('SIGKILL'); this.child.stdout.destroy(); this.child.stderr.destroy();
		})();
		return this.cleanup;
	}
}
