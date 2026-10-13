// Types for the control-core contract test. The control tsconfig sets `types` to
// an empty list, and this package does not depend on `@types/node`.
interface ImportMeta {
	url: string;
}

declare const process: { execPath: string };
declare module "node:test" {
	export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
	function equal(actual: unknown, expected: unknown, message?: string): void;
	function deepEqual(actual: unknown, expected: unknown, message?: string): void;
	function ok(value: unknown, message?: string): void;
	function match(value: string, expression: RegExp, message?: string): void;
	export { equal, deepEqual, ok, match };
}

declare module "node:fs" {
	function readFileSync(path: string, encoding: "utf8"): string;
	function readdirSync(path: string): string[];
	function mkdtempSync(prefix: string): string;
	function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
	export { readFileSync, readdirSync, mkdtempSync, rmSync };
}

declare module "node:os" {
	export function tmpdir(): string;
}

declare module "node:path" {
	export function resolve(...parts: string[]): string;
	export function join(...parts: string[]): string;
	export function dirname(file: string): string;
}

declare module "node:url" {
	export function fileURLToPath(url: string | URL): string;
}

declare module "node:child_process" {
	export function spawnSync(
		command: string,
		args: string[],
		options: { cwd: string; encoding: "utf8" },
	): { status: number | null; stdout: string; stderr: string };
}
