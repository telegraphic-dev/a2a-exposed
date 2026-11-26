import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { knownSkillResource, type SkillCatalog } from "../src/mcp-skills.ts";
import { serveSkills } from "./canonical-skills-fixture.ts";
import { buildSkillsCatalog } from "../scripts/mcp-skills-catalog.mjs";

const markdown = "---\nname: demo\ndescription: Example\nmetadata:\n  author: Example\n---\nInstructions\n";
const uri = "skill://demo/SKILL.md";
function fixture() {
	const bytes = { [uri]: Buffer.from(markdown), "skill://demo/bom.md": Buffer.from("\ufefftext\r\n"), "skill://demo/binary.bin": Buffer.from([0xff, 0x00]),
		"skill://demo/invalid.md": Buffer.from([0xc0, 0xaf]), "skill://demo/empty.md": Buffer.alloc(0),
		"skill://demo/unicode.md": Buffer.from("First\r\n\ufeffMiddle 😀\r\n") };
	const resources = Object.entries(bytes).map(([uri, raw]) => ({ uri, size: raw.length, digest: "sha256:" + crypto.createHash("sha256").update(raw).digest("hex") }));
	const catalog: SkillCatalog = { skills: [{ uri, frontmatter: { name: "demo", description: "Example", metadata: { author: "Example" } }, resources }],
		resources: Object.fromEntries(Object.entries(bytes).map(([uri, raw]) => [uri, raw.toString("base64")])) };
	return { bytes, catalog };
}
async function call(catalog: SkillCatalog, method: string, params = {}) {
	const message = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
		"io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
	} } };
	const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method,
		...("uri" in params ? { "mcp-name": String(params.uri) } : {}) };
	const response = await serveSkills(catalog, new Request("https://agent.example.com/mcp", { method: "POST", headers, body: JSON.stringify(message) }), message, { name: "test", version: "1" });
	return { response, data: await response.json() as any };
}

test("official SDK serves Skills manifests and resource bytes", async () => {
	const { bytes, catalog } = fixture();
	const listed = await call(catalog, "skills/list");
	assert.equal(listed.response.status, 200);
	assert.deepEqual(listed.data.result.skills, catalog.skills);
	assert.equal(listed.data.result.resultType, "complete");
	assert.equal(listed.data.result.cacheScope, "public");
	assert.equal(listed.data.result.ttlMs, 300_000);
	assert.deepEqual((await call(catalog, "skills/get", { uri })).data.result.skill, catalog.skills[0]);
	for (const [uri, expected] of Object.entries(bytes)) {
		const read = await call(catalog, "resources/read", { uri });
		assert.equal(read.response.status, 200);
		const content = read.data.result.contents[0];
		assert.deepEqual(content.text === undefined ? Buffer.from(content.blob, "base64") : Buffer.from(content.text), expected);
	}
});

test("Markdown uses lossless UTF-8 text, preserving BOM/CRLF; binary remains blob", async () => {
	const { bytes, catalog } = fixture();
	for (const [uri, expected] of Object.entries(bytes)) {
		const { data } = await call(catalog, "resources/read", { uri });
		const content = data.result.contents[0];
		if (uri.endsWith(".md") && !uri.endsWith("invalid.md")) {
			assert.equal(typeof content.text, "string");
			assert.equal(content.blob, undefined);
			assert.equal(content.mimeType, "text/markdown");
			assert.deepEqual(Buffer.from(content.text, "utf8"), expected);
		} else {
			assert.equal(content.text, undefined);
			assert.equal(content.mimeType, "application/octet-stream");
			assert.deepEqual(Buffer.from(content.blob, "base64"), expected);
		}
	}
});

test("exact resource membership rejects aliases before SDK URL routing", async () => {
	const { catalog } = fixture();
	assert.equal(knownSkillResource(catalog, uri), true);
	for (const value of ["skill://demo/references/../SKILL.md", "skill://demo/%53KILL.md", "skill://demo/./SKILL.md", "file:///etc/passwd", "https://example.com/file", null, 1]) {
		assert.equal(knownSkillResource(catalog, value), false);
		const rejected = await call(catalog, "resources/read", { uri: value });
		assert.ok(rejected.data.error, `unpublished URI must fail: ${value}`);
		assert.equal(rejected.data.result, undefined);
	}
});

test("official SDK catalog preserves canonical bytes and refuses symlinks", async (t) => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-sdk-catalog-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const folder = path.join(root, "skills/demo");
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "SKILL.md"), markdown);
	fs.writeFileSync(path.join(folder, "support.bin"), Buffer.from([0, 255]));
	const catalog = await buildSkillsCatalog(root);
	assert.equal(catalog.skills.length, 1);
	assert.equal(catalog.skills[0].resources.length, 2);
	assert.deepEqual(Buffer.from(catalog.resources[uri], "base64"), Buffer.from(markdown));
	fs.symlinkSync(path.join(folder, "SKILL.md"), path.join(folder, "alias.md"));
	await assert.rejects(buildSkillsCatalog(root), /symlink|unsupported|regular file/i);
});

test("canonical nested metadata passes official wire schemas unchanged", async () => {
	const catalog = await buildSkillsCatalog();
	assert.equal(catalog.skills.length, 2);
	for (const skill of catalog.skills) {
		assert.equal(typeof skill.frontmatter.metadata.hermes, "object");
		assert.equal(typeof skill.frontmatter.metadata.openclaw, "object");
		assert.deepEqual((await call(catalog, "skills/get", { uri: skill.uri })).data.result.skill, skill);
	}
});

test("official SDK wire client preserves canonical skills; convenience client incompatibility is explicit", async () => {
	const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
	const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
	const catalog = await buildSkillsCatalog();
	const client = new Client({ name: "skills-acceptance", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
	const transport = new StreamableHTTPClientTransport(new URL("https://agent.example.com/mcp"), {
		fetch: async (input, init) => {
			const req = new Request(input, init);
			const message = await req.clone().json();
			return serveSkills(catalog, req, message, { name: "test", version: "1" });
		},
	});
	try {
		await client.connect(transport);
		const { ListSkillsResultSchema, GetSkillResultSchema } = await import("@modelcontextprotocol/core/ext/skills");
		const listed = await client.request({ method: "skills/list", params: {} }, ListSkillsResultSchema);
		assert.equal(listed.skills.length, 2);
		for (const skill of listed.skills) {
			const got = await client.request({ method: "skills/get", params: { uri: skill.uri } }, GetSkillResultSchema);
			assert.deepEqual(got.skill, skill);
			assert.notEqual(skill.resources, "dynamic");
			for (const resource of skill.resources) {
				const read = await client.readResource({ uri: resource.uri });
				const content = read.contents[0];
				const bytes = content.blob === undefined ? Buffer.from(content.text) : Buffer.from(content.blob, "base64");
				assert.equal(bytes.length, resource.size);
				assert.equal("sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"), resource.digest);
			}
		}
		await assert.rejects(new SkillsClient(client).list(), /metadata must map strings to strings/);
	} finally { await client.close(); }
});

test("catalog refuses ambiguous YAML, aliases and non-JSON values", async (t) => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-yaml-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const folder = path.join(root, "skills/demo");
	fs.mkdirSync(folder, { recursive: true });
	for (const extra of ["name: other", "metadata: {x: .nan}", "metadata: {__proto__: bad}", "metadata: &meta {copy: *meta}", "metadata: !!set {x: null}"]) {
		fs.writeFileSync(path.join(folder, "SKILL.md"), `---\nname: demo\ndescription: Example\n${extra}\n---\nInstructions\n`);
		await assert.rejects(buildSkillsCatalog(root));
	}
});

test("nested skills remain complete supporting files and separate entries", async (t) => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mcp-nested-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, "skills/demo/child"), { recursive: true });
	fs.writeFileSync(path.join(root, "skills/demo/SKILL.md"), markdown);
	fs.writeFileSync(path.join(root, "skills/demo/child/SKILL.md"), markdown.replace("name: demo", "name: child"));
	const catalog = await buildSkillsCatalog(root);
	assert.equal(catalog.skills.length, 2);
	assert.equal(catalog.skills.find((s) => s.frontmatter.name === "demo").resources.length, 2);
	assert.equal(catalog.skills.find((s) => s.frontmatter.name === "child").resources.length, 1);
});
