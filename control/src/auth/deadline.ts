/** Bound for an OAuth callback. The provider token request has no timeout of its own. */
export const CALLBACK_DEADLINE_MS = 12_000;

/** Bound for the whole sign-in request, including the account lookup and the Turnstile check. */
export const SIGN_IN_DEADLINE_MS = 10_000;

/**
 * Resolve with `run` or, once `ms` has passed, with `onTimeout`.
 * A late failure from `run` is ignored after the deadline has already won.
 */
export function within(ms: number, run: () => Promise<Response>, onTimeout: () => Response): Promise<Response> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(onTimeout());
		}, ms);
		run().then(
			(response) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(response);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
