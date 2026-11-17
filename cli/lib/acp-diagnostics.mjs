/** Private, aggregate-bounded adapter stderr; never forward raw bytes to logs. */
import fs from 'node:fs';
import { CliError } from './a2a.mjs';
export const diagnosticsLimit = 1048576;
export function acpDiagnostics(file, onFailure = () => {}) {
	if (file === undefined) return { write() {}, close() {} };
	let fd, bytes = 0, failed = false;
	try {
		fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		fs.fchmodSync(fd, 0o600);
		if (!fs.fstatSync(fd).isFile()) throw new Error();
	} catch {
		if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve fixed creation diagnostic */ } }
		throw new CliError('ACP diagnostics creation failed; choose a new regular file in a private local directory (no overwrite or symlink)');
	}
	const fail = () => { if (!failed) { failed = true; onFailure(); } };
	return {
		write(chunk) {
			if (fd === undefined || failed || bytes >= diagnosticsLimit) return;
			try {
				const data = chunk.subarray(0, diagnosticsLimit - bytes);
				let at = 0;
				while (at < data.length) { const n = fs.writeSync(fd, data, at, data.length - at); if (!n) throw new Error(); at += n; bytes += n; }
			} catch { fail(); }
		},
		close() { if (fd === undefined) return; const owned = fd; fd = undefined; try { fs.closeSync(owned); } catch { fail(); } },
	};
}
