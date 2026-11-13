// Bound each integration-test await so an SDK/fixture hang reports its phase.
export async function relayPhase<T>(name: string, work: Promise<T>, timeoutMs: number, diagnostics = () => ""): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms; ${diagnostics()}`)), timeoutMs);
		})]);
	} finally { clearTimeout(timer); }
}
