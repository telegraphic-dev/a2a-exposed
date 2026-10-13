// Health, the feedback API, and static assets.
// A database plus the data plane turns on the outbox flush.
import { createApp } from "./app.ts";
import type { ControlEnv } from "./env.ts";
import { dataPlaneFromEnv, flushOutbox } from "./tenants/push.ts";

// One map for this isolate. A deploy without D1 still counts feedback posts across requests.
const feedbackLimits = new Map<string, number>();

export default {
	fetch(request: Request, env: ControlEnv, ctx: ExecutionContext) {
		return createApp(env, { memory: feedbackLimits }).fetch(request, env, ctx);
	},
	async scheduled(_controller: ScheduledController, env: ControlEnv): Promise<void> {
		const plane = dataPlaneFromEnv(env);
		if (!plane || !env.DB) return;
		await flushOutbox(env.DB, plane);
	},
} satisfies ExportedHandler<ControlEnv>;
