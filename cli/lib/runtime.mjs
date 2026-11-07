// Runtime diagnostics only: inspect paths, never execute a saved wake command.
import fs from "node:fs";
import path from "node:path";
import * as C from "./config.mjs";

const canonical = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
export const sameExecutable = (a, b) => !!a && !!b && canonical(a) === canonical(b);

export function pathNode(env = process.env) {
	for (const dir of (env.PATH || "").split(path.delimiter)) {
		const file = path.resolve(dir || ".", process.platform === "win32" ? "node.exe" : "node");
		try {
			fs.accessSync(file, fs.constants.X_OK);
			if (fs.statSync(file).isFile()) return file;
		} catch { /* try the next PATH entry */ }
	}
	return null;
}

/** Pin env-based Node shebangs (including npx and its children) to this runtime. */
export function pinnedCommand(execPath = process.execPath) {
	return `env PATH=${C.shellQuote(path.dirname(execPath))}:"$PATH" ${C.CLI_COMMAND}`;
}

// Read the first shell word without evaluating expansions, substitutions or commands.
function firstWord(text) {
	text = text.trim();
	let word = "", quote = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) quote = "";
			else if (c === "\\" && quote === '"') word += text[++i] || "";
			else word += c;
		} else if (c === "'" || c === '"') quote = c;
		else if (/\s/.test(c)) break;
		else if (c === "\\") word += text[++i] || "";
		else word += c;
	}
	return quote ? "" : word;
}

export function runtimeInfo({ execPath = process.execPath, node = process.versions.node,
	pathExecPath = pathNode(), initExecPath = C.get("A2A_NODE_EXEC_PATH"), command = C.get("WAKE_CLI_COMMAND", C.CLI_COMMAND) } = {}) {
	const first = firstWord(command);
	let wakeExecPath = null;
	if (command === pinnedCommand(execPath)) wakeExecPath = execPath;
	else if (initExecPath && command === pinnedCommand(initExecPath)) wakeExecPath = initExecPath;
	else if (/^(node|npx|a2a-exposed)(\.exe|\.cmd)?$/.test(first)) wakeExecPath = pathExecPath;
	else if (/^node(\.exe)?$/.test(path.basename(first)) && path.isAbsolute(first)) wakeExecPath = first;
	const warning = wakeExecPath && !sameExecutable(wakeExecPath, execPath)
		? `WAKE_CLI_COMMAND selects a different Node (${wakeExecPath}); this process uses ${execPath}. Pin the wake runtime with --cli-command (see env --help).` : null;
	return { node, execPath, initExecPath: initExecPath || null, pathExecPath, wakeExecPath, warning };
}
