import { afterAll, afterEach, beforeAll } from "vitest";
import { network } from "./network.ts";

beforeAll(() => {
	network.configure({ onUnhandledFrame: "error" });
	return network.enable();
});

afterEach(() => {
	network.resetHandlers();
});

afterAll(() => network.disable());
