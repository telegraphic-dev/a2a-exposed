/** Stop waiting even when an internal binding ignores cancellation. Callers pass
 * the signal into every request and check it before starting another side effect. */
export async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
	const controller = new AbortController();
	const cancel = () => controller.abort(parent?.reason);
	if (parent?.aborted) cancel();
	else parent?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("Reply delivery timed out; its outcome may be uncertain")), ms);
	let stop!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		stop = () => reject(controller.signal.reason);
		controller.signal.addEventListener("abort", stop, { once: true });
	});
	try {
		controller.signal.throwIfAborted();
		return await Promise.race([run(controller.signal), aborted]);
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", cancel);
		controller.signal.removeEventListener("abort", stop);
	}
}
