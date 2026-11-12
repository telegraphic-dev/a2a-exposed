import test from "node:test";
import assert from "node:assert/strict";
import { sealBackup, openBackup, MAX_BACKUP_PLAINTEXT } from "../backup.mjs";
const password = Buffer.from("synthetic test backup passphrase");
const snapshot = { v: 1, privateKeys: [{ synthetic: "private-backup-canary" }], pins: [{ verification: "independent" }], replay: ["message-1"] };

test("backups protect complete local snapshot and use fresh salt/nonce", () => {
 const a=sealBackup(snapshot,password),b=sealBackup(snapshot,password);
 assert.notEqual(a,b);assert.ok(!a.includes("private-backup-canary"));assert.deepEqual(openBackup(a,password),snapshot);
 assert.deepEqual(openBackup(a,Buffer.from("synthetic test backup passphrase\n")),snapshot);
 assert.deepEqual(openBackup(a,Buffer.from("synthetic test backup passphrase\r\n")),snapshot);
 assert.deepEqual(password,Buffer.from("synthetic test backup passphrase"));
});

test("wrong passphrase, authenticated-header tampering and unsupported parameters fail safely", () => {
 const text=sealBackup(snapshot,password);
 assert.throws(()=>openBackup(text,Buffer.from("another synthetic passphrase")),{code:"backup_unreadable"});
 for(const edit of [e=>e.N=2147483648,e=>e.r=1,e=>e.p=2,e=>e.v=2,e=>e.salt="A".repeat(43),e=>e.nonce="A".repeat(16),e=>e.ct=e.ct.slice(1),e=>e.extra="private-error-canary"]) {
  const changed=JSON.parse(text);edit(changed);
  assert.throws(()=>openBackup(JSON.stringify(changed),password),error=>error.code&&!String(error).includes("private-error-canary"));
 }
 assert.throws(()=>openBackup(text.replace('"v":1','"v":1,"\\u0076":1'),password));
});

test("passphrase boundaries, malformed UTF8 and oversized snapshots reject before backup output", () => {
 for(const value of [Buffer.from("short"),Buffer.alloc(5000,65),Buffer.from([0xff,0xfe]),"never-argv"])assert.throws(()=>sealBackup(snapshot,value),{code:"passphrase_input"});
 assert.throws(()=>sealBackup({value:"x".repeat(MAX_BACKUP_PLAINTEXT)},password),{code:"backup_too_large"});
});

test("backup supports a bounded snapshot larger than transport JSON without relaxing transport defaults", () => {
 const value={synthetic:"x".repeat(1024*1024+32)};
 const encrypted=sealBackup(value,password);assert.deepEqual(openBackup(encrypted,password),value);
});
