/** Trim a feedback id for a plain Worker binding.
 *  A non-empty value is kept even when it is not digits, so the worker can
 *  answer 502. Blank is unset and is not bound. Dropping a typo here would
 *  look like an unset app and could fall back to the personal access token.
 */
export function feedbackPlainId(value: string | undefined): string {
	return (value ?? "").trim();
}
