import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(new URL("../public/owner-token.js", import.meta.url), "utf8");

function mount(value: string) {
	const field = {
		value,
		nodeType: 1,
		focused: false,
		selected: false,
		focus() { this.focused = true; },
		select() { this.selected = true; },
		contains(node: unknown) { return node === this; },
	};
	const button = {
		hidden: true,
		textContent: "Copy",
		listeners: {} as Record<string, (event: unknown) => void>,
		addEventListener(type: string, fn: (event: unknown) => void) { this.listeners[type] = fn; },
	};
	const root = {
		removed: false,
		querySelector(sel: string) {
			if (sel === ".token-value") return field;
			if (sel === ".copy-token") return button;
			return null;
		},
		remove() { this.removed = true; },
	};
	const listeners: Record<string, Array<(event: unknown) => void>> = {};
	const written: string[] = [];
	let selection: { rangeCount: number; anchorNode: unknown } | null = null;
	const document = {
		querySelector(sel: string) { return sel === ".token" ? root : null; },
		querySelectorAll(sel: string) { return sel === ".token" ? [root] : []; },
		addEventListener(type: string, fn: (event: unknown) => void) { (listeners[type] ??= []).push(fn); },
		getSelection() { return selection; },
		execCommand() { return false; },
	};
	const window = { addEventListener(type: string, fn: (event: unknown) => void) { (listeners[type] ??= []).push(fn); } };
	const navigator = { clipboard: { writeText(text: string) { written.push(text); return Promise.resolve(); } } };
	vm.runInNewContext(script, { document, window, navigator });
	return { field, button, root, listeners, written, select(node: unknown) { selection = { rangeCount: 1, anchorNode: node }; } };
}

test("the copy button writes the token with no surrounding whitespace", async () => {
	const page = mount("  a2aot_abc \n");
	assert.equal(page.button.hidden, false);
	page.button.listeners.click?.({});
	await Promise.resolve();
	assert.deepEqual(page.written, ["a2aot_abc"]);
	assert.equal(page.button.textContent, "Copied");
});

test("a copy of the token field is the token alone", () => {
	const page = mount(" a2aot_abc\n");
	page.select(page.field);
	let plain = "";
	let prevented = false;
	page.listeners.copy?.[0]?.({
		clipboardData: { setData(_type: string, value: string) { plain = value; } },
		preventDefault() { prevented = true; },
	});
	assert.equal(prevented, true);
	assert.equal(plain, "a2aot_abc");
});

test("without the clipboard API the token field is selected", () => {
	const field = {
		value: "a2aot_abc",
		nodeType: 1,
		focused: false,
		selected: false,
		focus() { this.focused = true; },
		select() { this.selected = true; },
		contains() { return false; },
	};
	const button = {
		hidden: true,
		textContent: "Copy",
		listeners: {} as Record<string, () => void>,
		addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; },
	};
	const root = {
		querySelector(sel: string) {
			if (sel === ".token-value") return field;
			if (sel === ".copy-token") return button;
			return null;
		},
	};
	vm.runInNewContext(script, {
		document: {
			querySelector() { return root; },
			querySelectorAll(sel: string) { return sel === ".token" ? [root] : []; },
			addEventListener() {},
			execCommand() { return true; },
		},
		window: { addEventListener() {} },
		navigator: {},
	});
	button.listeners.click?.();
	assert.equal(field.selected, true);
	assert.equal(button.textContent, "Copied");
});
