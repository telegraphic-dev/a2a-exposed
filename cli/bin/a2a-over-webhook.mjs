#!/usr/bin/env node
// Deprecated command name: the project is now a2a-exposed. This alias runs the same CLI (same commands, same config)
// and will be removed in a future minor release.
if (!process.env.A2A_NO_RENAME_NOTICE)
	console.error("note: `a2a-over-webhook` is now `a2a-exposed` (npm i -g a2a-exposed@latest); this alias will be removed in a future release. Silence: A2A_NO_RENAME_NOTICE=1");
await import("./a2a-exposed.mjs");
