// Private child-process protocol. Never invoke from an agent tool or return its output directly.
import { AsyncEntry } from "@napi-rs/keyring";
let text = "";
try {
 for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 16384) throw Error(); }
 const input = JSON.parse(text);
 if (!/^[a-f0-9-]{36}$/.test(input.namespace) || !/^[a-f0-9-]{36}\/[A-Za-z0-9_-]{43}$/.test(input.account)) throw Error();
 const entry = new AsyncEntry("a2a-exposed.local-encryption.v1." + input.namespace, input.account, { linux: { store: "secret-service" } });
 let value;
 if (input.op === "get") value = await entry.getPassword();
 else if (input.op === "set" && typeof input.value === "string" && input.value.length < 12000) {
  await entry.setPassword(input.value);
  if (await entry.getPassword() !== input.value) throw Error();
 } else if (input.op === "delete") {
  await entry.deleteCredential();
  if (await entry.getPassword() !== null) throw Error();
 } else throw Error();
 process.stdout.write(JSON.stringify({ ok: true, ...(input.op === "get" ? { value } : {}) }));
} catch { process.stdout.write('{"ok":false,"code":"key_store_unavailable"}'); process.exitCode = 1; }
