// Node's "pipe" stdin is a socket on macOS. BSD script refuses its ioctl
// error, so relay stdin through a real shell pipe before allocating the PTY.
import { spawn } from "node:child_process";

export function spawnScript(args, options = {}) {
	if (process.platform !== "darwin") return spawn("script", args, { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	// All command arguments remain positional, never interpolated into shell code.
	// fd 3 reports script completion so cat cannot keep the wrapper alive waiting
	// for input. The terminal job cannot write that channel or inherit it.
	const relay = '/bin/cat | { "$@" 3>&-; result=$?; printf "%s\\n" "$result" >&3; exit "$result"; }';
	const child = spawn("/bin/sh", ["-c", relay, "a2a-script", "/usr/bin/script", ...args], {
		...options, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
	});
	child.stdio[3].once("data", () => child.stdin.end());
	child.stdio[3].resume();
	child.stdin.on("error", () => {}); // script can exit just before an answer.
	return child;
}

export function stopScript(child, signal = "SIGTERM") {
	if (!child.pid) return false;
	try {
		// Stop the relay and script together. Closing the PTY master also hangs
		// up the terminal job rather than leaving it waiting for an answer.
		process.kill(-child.pid, signal);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}
