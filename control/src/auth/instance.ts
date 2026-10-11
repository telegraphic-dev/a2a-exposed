import { createAuth, type Auth } from "./create-auth.ts";
import { resolveAuth, type AuthDeps, type AuthEnv, type AuthOptions } from "./options.ts";

/**
 * Build the auth handler for this request. D1 belongs to the request that
 * received the binding. A handler kept from an earlier request waits on that
 * binding and never answers.
 */
export async function loadAuth(env: AuthEnv, request: Request, deps: AuthDeps = {}): Promise<{ auth: Auth; options: AuthOptions } | null> {
	const options = resolveAuth(env, request, deps);
	if (!options) return null;
	return { auth: await createAuth(options), options };
}
