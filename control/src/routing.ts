// Paths that must reach Hono. Everything else is a static asset and does not invoke the Worker.
// cf 1.0.0-beta.13 types `runWorkerFirst` as `string[] | boolean`: path patterns only, no header
// match, so `Accept: text/markdown` cannot be selected here. Twin `.md` files are static assets;
// negotiation runs only when a request already reaches the Worker (see src/app.ts).
export const RUN_WORKER_FIRST = [
	"/health",
	"/app",
	"/app/*",
	"/api",
	"/api/*",
	"/.well-known",
	"/.well-known/*",
];
