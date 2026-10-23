// `inbox` follows every cursor. A safety cap errors instead of returning a short list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "../lib/a2a.mjs";
import { INBOX_MAX_PAGES, followInbox } from "../lib/commands.mjs";

test("followInbox keeps going past 100 pages", async () => {
	const pages = 101;
	const rows = await followInbox(async (cursor) => {
		const page = cursor ? Number(cursor) : 0;
		assert.ok(page < pages);
		const next = page + 1 < pages ? String(page + 1) : "";
		return { rows: [{ taskId: `t-${page}` }], cursor: next };
	});
	assert.equal(rows.length, pages);
	assert.equal(rows[0].taskId, "t-0");
	assert.equal(rows[pages - 1].taskId, `t-${pages - 1}`);
	assert.ok(pages > 100);
	assert.ok(INBOX_MAX_PAGES > pages);
});

test("followInbox errors when the safety cap is reached", async () => {
	let calls = 0;
	await assert.rejects(() => followInbox(async (cursor) => {
		calls++;
		return { rows: [{ taskId: cursor || "t-0" }], cursor: `c-${calls}` };
	}, 3), (error) => error instanceof CliError && /longer than 3 pages/.test(error.message) && /partial list/.test(error.message));
	assert.equal(calls, 3, "the cap is the last page fetched; the command does not return those rows");
});

test("followInbox errors when a cursor repeats", async () => {
	await assert.rejects(() => followInbox(async (cursor) => {
		if (!cursor) return { rows: [{ taskId: "a" }], cursor: "page-b" };
		if (cursor === "page-b") return { rows: [{ taskId: "b" }], cursor: "page-a" };
		return { rows: [{ taskId: "a-again" }], cursor: "page-b" };
	}, 10), (error) => error instanceof CliError && /cursor repeated/.test(error.message) && /partial list/.test(error.message));
});
