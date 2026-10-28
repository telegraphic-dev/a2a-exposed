// The self-host inbox schema. Keep this list equal to worker/src/migrations.ts.
// `cf d1 migrations apply` records each file name in d1_migrations. The same statements
// run over the Cloudflare HTTP API. Tests import this module.
import type { InboxMigration } from "./inbox.ts";
import m0001 from "../../../worker/migrations/0001_init.sql?raw";
import m0002 from "../../../worker/migrations/0002_wake_budget.sql?raw";
import m0003 from "../../../worker/migrations/0003_device_pairing.sql?raw";
import m0004 from "../../../worker/migrations/0004_pairing_replace.sql?raw";
import m0005 from "../../../worker/migrations/0005_facade_owners.sql?raw";
import m0006 from "../../../worker/migrations/0006_mcp.sql?raw";
import m0007 from "../../../worker/migrations/0007_cimd.sql?raw";
import m0008 from "../../../worker/migrations/0008_oidc_txns.sql?raw";
import m0009 from "../../../worker/migrations/0009_outbound_seen.sql?raw";
import m0010 from "../../../worker/migrations/0010_conversation_peer.sql?raw";
import m0011 from "../../../worker/migrations/0011_conversation_owner.sql?raw";
import m0012 from "../../../worker/migrations/0012_conversation_peer_owner.sql?raw";
import m0013 from "../../../worker/migrations/0013_reply_delivery.sql?raw";

export type { InboxMigration };

export const INBOX_MIGRATIONS: InboxMigration[] = [
	{ name: "0001_init.sql", sql: m0001 },
	{ name: "0002_wake_budget.sql", sql: m0002 },
	{ name: "0003_device_pairing.sql", sql: m0003 },
	{ name: "0004_pairing_replace.sql", sql: m0004 },
	{ name: "0005_facade_owners.sql", sql: m0005 },
	{ name: "0006_mcp.sql", sql: m0006 },
	{ name: "0007_cimd.sql", sql: m0007 },
	{ name: "0008_oidc_txns.sql", sql: m0008 },
	{ name: "0009_outbound_seen.sql", sql: m0009 },
	{ name: "0010_conversation_peer.sql", sql: m0010 },
	{ name: "0011_conversation_owner.sql", sql: m0011 },
	{ name: "0012_conversation_peer_owner.sql", sql: m0012 },
	{ name: "0013_reply_delivery.sql", sql: m0013 },
];
