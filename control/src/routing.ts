// Every request reaches Hono. `runWorkerFirst` cannot match on `Accept`, so a path list would
// let the asset layer answer `/guide` with HTML and skip markdown negotiation. Unmatched
// requests are served from `env.ASSETS` (see src/app.ts).
export const RUN_WORKER_FIRST = true;
