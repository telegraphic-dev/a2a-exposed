// Inbox migrations bundled into the Worker. Vite inlines each `?raw` import.
// A new file in worker/migrations/ must be added here; storage tests check the two lists match.
import m0001 from "../migrations/0001_init.sql?raw";
import m0002 from "../migrations/0002_wake_budget.sql?raw";
import m0003 from "../migrations/0003_device_pairing.sql?raw";
import m0004 from "../migrations/0004_pairing_replace.sql?raw";
import m0005 from "../migrations/0005_facade_owners.sql?raw";
import m0006 from "../migrations/0006_mcp.sql?raw";
import m0007 from "../migrations/0007_cimd.sql?raw";
import m0008 from "../migrations/0008_oidc_txns.sql?raw";
import type { Migration } from "./storage.ts";

export const MIGRATIONS: Migration[] = [
	{ name: "0001_init.sql", sql: m0001 },
	{ name: "0002_wake_budget.sql", sql: m0002 },
	{ name: "0003_device_pairing.sql", sql: m0003 },
	{ name: "0004_pairing_replace.sql", sql: m0004 },
	{ name: "0005_facade_owners.sql", sql: m0005 },
	{ name: "0006_mcp.sql", sql: m0006 },
	{ name: "0007_cimd.sql", sql: m0007 },
	{ name: "0008_oidc_txns.sql", sql: m0008 },
];
