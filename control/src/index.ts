// Control plane: Hono for /app, /api, /health and /.well-known. Static assets serve every other path.
// With no bindings set, this is a neutral shell: no login provider, no billing, no hosted name.
import { createApp } from "./app.ts";
import type { ControlEnv } from "./env.ts";
import { dataPlaneFromEnv, flushOutbox } from "./tenants/push.ts";

export default {
	fetch(request: Request, env: ControlEnv, ctx: ExecutionContext) {
		return createApp(env).fetch(request, env, ctx);
	},
	async scheduled(_controller: ScheduledController, env: ControlEnv): Promise<void> {
		const plane = dataPlaneFromEnv(env);
		if (!plane || !env.DB) return;
		await flushOutbox(env.DB, plane);
	},
} satisfies ExportedHandler<ControlEnv>;
