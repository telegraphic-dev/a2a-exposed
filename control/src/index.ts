// Control plane: Hono for /app, /api, /health and /.well-known. Static assets serve every other path.
// With no bindings set, this is a neutral shell: no login provider, no billing, no hosted name.
import { createApp } from "./app.ts";
import type { ControlEnv } from "./env.ts";

export default {
	fetch(request: Request, env: ControlEnv, ctx: ExecutionContext) {
		return createApp(env).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<ControlEnv>;
