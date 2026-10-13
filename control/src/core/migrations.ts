// Control D1 migrations, in the same order `cf d1 migrations apply` runs them.
// The same files ship in this package at CONTROL_MIGRATIONS_DIR for `--dir`.
import m0001 from "../../migrations/0001_auth.sql?raw";
import m0002 from "../../migrations/0002_tenants.sql?raw";
import m0003 from "../../migrations/0003_oidc.sql?raw";
import m0004 from "../../migrations/0004_device.sql?raw";
import m0005 from "../../migrations/0005_agent_limit.sql?raw";
import m0006 from "../../migrations/0006_agent_limit_account.sql?raw";
import m0007 from "../../migrations/0007_outbox_lock.sql?raw";
import m0008 from "../../migrations/0008_account_provider.sql?raw";
import m0009 from "../../migrations/0009_feedback_rate.sql?raw";
import m0010 from "../../migrations/0010_cloudflare_grant.sql?raw";
import m0011 from "../../migrations/0011_cloudflare_inbox.sql?raw";
import m0012 from "../../migrations/0012_cloudflare_inbox_tag.sql?raw";
import m0013 from "../../migrations/0013_cloudflare_inbox_wizard.sql?raw";
import m0014 from "../../migrations/0014_cloudflare_inbox_agent.sql?raw";

export interface ControlMigration {
	name: string;
	sql: string;
}

/** Path of the migration directory inside the `@a2a-exposed/control-core` package. */
export const CONTROL_MIGRATIONS_DIR = "control/migrations";

export const CONTROL_MIGRATIONS: readonly ControlMigration[] = [
	{ name: "0001_auth.sql", sql: m0001 },
	{ name: "0002_tenants.sql", sql: m0002 },
	{ name: "0003_oidc.sql", sql: m0003 },
	{ name: "0004_device.sql", sql: m0004 },
	{ name: "0005_agent_limit.sql", sql: m0005 },
	{ name: "0006_agent_limit_account.sql", sql: m0006 },
	{ name: "0007_outbox_lock.sql", sql: m0007 },
	{ name: "0008_account_provider.sql", sql: m0008 },
	{ name: "0009_feedback_rate.sql", sql: m0009 },
	{ name: "0010_cloudflare_grant.sql", sql: m0010 },
	{ name: "0011_cloudflare_inbox.sql", sql: m0011 },
	{ name: "0012_cloudflare_inbox_tag.sql", sql: m0012 },
	{ name: "0013_cloudflare_inbox_wizard.sql", sql: m0013 },
	{ name: "0014_cloudflare_inbox_agent.sql", sql: m0014 },
];
