// Holds a local-state write transaction open until killed (#384 fault injection).
// argv: <configDir> <mode>. mode "locked": a LocalState.locked() action writes a canary row, then waits.
// mode "raw": a second SQLite connection holds BEGIN IMMEDIATE on state.sqlite, then waits.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalState } from "../../local-state.mjs";

const [dir, mode] = process.argv.slice(2);
if (mode === "raw") {
 const db = new DatabaseSync(path.join(dir, "encryption", "state.sqlite"));
 db.exec("BEGIN IMMEDIATE");
 db.prepare("INSERT INTO meta VALUES('fault_holder_384','uncommitted')").run();
 process.stdout.write("IN_TX\n");
 setInterval(() => {}, 1000);
} else {
 const state = new LocalState(dir, { write: true });
 state.locked(async () => {
  state.db.prepare("INSERT INTO meta VALUES('fault_canary_384','uncommitted')").run();
  process.stdout.write("IN_TX\n");
  await new Promise(() => {});
 });
}
