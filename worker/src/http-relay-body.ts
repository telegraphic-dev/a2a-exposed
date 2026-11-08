// Shared bounded reader, kept runtime-neutral so native Web Streams cancellation
// ordering is qualified as well as the workerd network-stream implementation.
export async function readHttpRelayBody(req: Request, limits: { requestBytes: number; headerMs: number }): Promise<Uint8Array> {
	const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = []; let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined; let expired = false;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
		expired = true;
		// Reject first: cancel() can synchronously resolve reader.read() as EOF.
		reject(new Error("timeout"));
		void reader.cancel().catch(() => {});
	}, limits.headerMs); });
	try {
		while (true) {
			const { value, done } = await Promise.race([reader.read(), timeout]);
			if (expired) throw new Error("timeout");
			if (done) break;
			size += value.length; if (size > limits.requestBytes) { void reader.cancel().catch(() => {}); throw new Error("size"); } chunks.push(value);
		}
		const result = new Uint8Array(size); let offset = 0;
		for (const c of chunks) { result.set(c, offset); offset += c.length; } return result;
	} finally { if (timer !== undefined) clearTimeout(timer); reader.releaseLock(); }
}
