import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { buildSkillsCatalog, DEFAULT_ROOT } from "../scripts/mcp-skills-catalog.mjs";
import { buildPortableSkillsCatalog, portableCatalog } from "../scripts/mcp-portable-skills-catalog.mjs";
import { servePortableSkills } from "../src/mcp-skills.ts";

function body(text: string) { return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""); }
const sha = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");

test("portable edition is deterministic, explicit, and leaves every canonical source byte intact", async () => {
	const canonical = await buildSkillsCatalog();
	const before = JSON.stringify(canonical);
	const portable = await buildPortableSkillsCatalog();
	assert.deepEqual(await buildPortableSkillsCatalog(), portable);
	assert.equal(JSON.stringify(canonical), before);
	for (const skill of portable.skills) {
		assert.ok(skill.uri.startsWith("skill://portable/"));
		const originalUri = skill.uri.replace("skill://portable/", "skill://");
		const original = canonical.skills.find((s) => s.uri === originalUri)!;
		assert.deepEqual(Object.keys(skill.frontmatter.metadata).sort(), ["author", "homepage", "version"]);
		assert.equal(skill.frontmatter.metadata.version, original.frontmatter.metadata.version);
		assert.equal(body(Buffer.from(portable.resources[skill.uri], "base64").toString()), body(Buffer.from(canonical.resources[originalUri], "base64").toString()));
		for (const resource of skill.resources) {
			const raw = Buffer.from(portable.resources[resource.uri], "base64");
			assert.equal(resource.size, raw.length);
			assert.equal(resource.digest, "sha256:" + sha(raw));
			const originalResource = resource.uri.replace("skill://portable/", "skill://");
			if (resource.uri !== skill.uri) assert.deepEqual(raw, Buffer.from(canonical.resources[originalResource], "base64"));
			const relative = originalResource.slice("skill://".length).split("/").map(decodeURIComponent).join("/");
			assert.deepEqual(Buffer.from(canonical.resources[originalResource], "base64"), fs.readFileSync(path.join(DEFAULT_ROOT, "skills", relative)));
		}
	}
});

test("portable edition rejects unassigned metadata, top-level fields and companion changes", async () => {
	for (const mutate of [
		(c) => { c.skills[0].frontmatter.unassigned = "value"; },
		(c) => { c.skills[0].frontmatter.metadata.unassigned = "value"; },
		(c) => { c.skills[0].frontmatter.metadata.version = 1; },
		(c) => { c.skills = c.skills.slice(1); },
		(c) => { c.skills.find((s) => s.frontmatter.name === "a2a-exposed").frontmatter.metadata.required_skills.push("another"); },
	]) {
		const canonical = await buildSkillsCatalog();
		mutate(canonical);
		await assert.rejects(portableCatalog(canonical));
	}
});

test("source inventory rejects unreviewed files before reading their bytes", async () => {
	const canonical = await buildSkillsCatalog();
	const allowedPaths = new Set(Object.keys(canonical.resources).map((uri) => uri.slice("skill://".length)));
	allowedPaths.delete("a2a-exposed/SKILL.md");
	await assert.rejects(buildSkillsCatalog(DEFAULT_ROOT, { allowedPaths }), /unreviewed skill file/);
});

test("strict official server extension and SkillsClient load both portable skills and every file", async () => {
	const catalog = await buildPortableSkillsCatalog();
	const client = new Client({ name: "portable-acceptance", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
	const transport = new StreamableHTTPClientTransport(new URL("https://agent.example.com/mcp"), {
		fetch: async (input, init) => {
			const request = new Request(input, init);
			return servePortableSkills(catalog, request, await request.clone().json(), { name: "portable-test", version: "1" });
		},
	});
	try {
		await client.connect(transport);
		const skills = new SkillsClient(client);
		const listed = await skills.list();
		assert.equal(listed.skills.length, 2);
		let files = 0;
		for (const skill of listed.skills) {
			assert.deepEqual((await skills.get(skill.uri)).skill, skill);
			for (const resource of skill.resources) {
				const file = await skills.read(skill, resource.uri);
				assert.equal(file.verified, true);
				assert.deepEqual(Buffer.from(file.bytes), Buffer.from(catalog.resources[resource.uri], "base64"));
				files++;
			}
		}
		assert.equal(files, 16);
	} finally { await client.close(); }
});

test("portable extension refuses canonical identities and normalized aliases", async () => {
	const catalog = await buildPortableSkillsCatalog();
	for (const uri of ["skill://a2a-exposed/SKILL.md", "skill://portable/a2a-exposed/sub/../SKILL.md", "skill://portable/a2a-exposed/%53KILL.md", "https://example.com/file"]) {
		const method = "resources/read";
		const message = { jsonrpc: "2.0", id: 1, method, params: { uri, _meta: {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
			"io.modelcontextprotocol/clientInfo": { name: "portable-test", version: "1" },
		} } };
		const request = new Request("https://agent.example.com/mcp", { method: "POST", headers: {
			"content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, "mcp-name": uri,
		}, body: JSON.stringify(message) });
		const response = await servePortableSkills(catalog, request, message, { name: "portable-test", version: "1" });
		const data = await response.json();
		assert.ok(data.error);
		assert.equal(data.result, undefined);
	}
});
