# @a2a-exposed/control-core

This directory is the source for `@a2a-exposed/control-core`. The source entry is `src/core/index.ts`. It exports tenants, Cloudflare inbox provisioning, routing helpers, the `ControlEnv` type, and the D1 migrations in `migrations/`.

The published module is compiled JavaScript and TypeScript declarations. `prepare` at the repository root builds that module on `npm pack` and on a `file:` install. The `a2a-exposed` CLI package leaves this directory out.

From this directory, `npm test` runs the Node tests and a Vitest suite inside Miniflare. That suite runs the Cloudflare provisioning calls in workerd against a mocked Cloudflare API.
