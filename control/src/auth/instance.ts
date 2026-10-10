import { createAuth, type Auth } from "./create-auth.ts";
import { resolveAuth, type AuthDeps, type AuthEnv, type AuthOptions } from "./options.ts";

const cache = new WeakMap<object, Map<string, Promise<Auth>>>();

export async function loadAuth(env: AuthEnv, request: Request, deps: AuthDeps = {}): Promise<{ auth: Auth; options: AuthOptions } | null> {
	const options = resolveAuth(env, request, deps);
	if (!options) return null;
	const host = env as object;
	let origins = cache.get(host);
	if (!origins) {
		origins = new Map();
		cache.set(host, origins);
	}
	let pending = origins.get(options.baseURL);
	if (!pending) {
		pending = createAuth(options);
		origins.set(options.baseURL, pending);
	}
	return { auth: await pending, options };
}
