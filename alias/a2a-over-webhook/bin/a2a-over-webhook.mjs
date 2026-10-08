#!/usr/bin/env node
// Deprecated package and command: a2a-over-webhook is now a2a-exposed. This alias runs the a2a-exposed CLI it depends
// on (same commands, same config) and will be removed in a future minor release.
if (!process.env.A2A_NO_RENAME_NOTICE)
	console.error("note: `a2a-over-webhook` is now `a2a-exposed` (npm i -g a2a-exposed@latest; npx a2a-exposed ...); this alias will be removed in a future release. Silence: A2A_NO_RENAME_NOTICE=1");
await import("a2a-exposed/bin/a2a-exposed.mjs");
