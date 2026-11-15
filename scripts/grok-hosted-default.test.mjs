import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

test("Grok Bot setup docs default to the setup skill and CLI hosted login", () => {
	const files = {
		skill: "skills/a2a-exposed-setup/SKILL.md",
		wake: "skills/a2a-exposed-setup/references/wake.md",
		gettingStarted: "docs/getting-started.md",
		receiving: "docs/receiving-messages.md",
		readme: "README.md",
	};
	const texts = Object.fromEntries(
		Object.entries(files).map(([key, rel]) => [key, fs.readFileSync(path.join(root, rel), "utf8")]),
	);

	for (const [name, text] of Object.entries(texts)) {
		assert.match(text, /https:\/\/a2a\.exposed\/mcp/, `${name} names the hosted MCP URL`);
		assert.match(text, /not in the Grok Bot plugin catalog/, `${name} notes the catalog gap`);
		assert.match(text, /login --machine/, `${name} names CLI hosted login`);
		assert.match(text, /hosted create --name/, `${name} names hosted create`);
		assert.match(text, /wake set --agent NAME --preset grok-bot|wake set --preset grok-bot/, `${name} names grok-bot wake set`);
		assert.doesNotMatch(
			text,
			/For a Grok Bot, a2a\.exposed only works on a self-hosted Worker/,
			`${name} does not claim Grok Bot is self-host only`,
		);
	}

	assert.match(texts.wake, /Hosted skill \+ CLI \(default\)/);
	assert.match(texts.wake, /Hosted MCP connector \(alternative\)/);
	assert.match(texts.wake, /Self-hosted opt-in/);
	assert.match(texts.skill, /chmod 600/);
	assert.match(texts.readme, /chmod 600/);
	assert.match(
		texts.gettingStarted,
		/Self-host only if the owner wants a Worker in their own Cloudflare account/,
	);
	assert.match(texts.skill, /Self-host only if the human already has or asks for a Cloudflare account/);
});
