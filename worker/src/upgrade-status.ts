import type { SqlDb } from "./tenancy.ts";
import { MIGRATION_NAMES } from "./version.ts";

/** Owner-only public build/schema facts. Never apply migrations or return database contents. */
export async function upgradeStatus(db: SqlDb, version: string, hosted: boolean) {
 const expected = MIGRATION_NAMES;
 try {
  const rows = await db.prepare("SELECT name FROM d1_migrations LIMIT 1000").all<{ name: string }>();
  const applied = new Set((rows.results || []).map(r => r.name));
  return { version, management: hosted ? "platform" : "self-hosted", schema: { status: "known", expected, applied: expected.filter(n => applied.has(n)), pending: expected.filter(n => !applied.has(n)) } };
 } catch {
  return { version, management: hosted ? "platform" : "self-hosted", schema: { status: "unknown", expected, applied: null, pending: null } };
 }
}
