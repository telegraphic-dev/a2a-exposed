// Bounded native child protocol. Secrets travel only through local pipes, never argv/env.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export class NativeStoreError extends Error {
 constructor(code, pid) { super(code); this.code = code; if (pid) this.pid = pid; }
}
export async function nativeCredentialOperation(input, { allowOsConsent = false, onSpawn, spawnImpl = spawn, timeoutMs = 5000, graceMs = 500, platform = process.platform } = {}) {
 if (allowOsConsent !== true) throw new NativeStoreError("key_store_consent");
 if (!["get", "set", "delete"].includes(input?.op) || !/^[a-f0-9-]{36}$/.test(input.namespace || "") || !/^[a-f0-9-]{36}\/[A-Za-z0-9_-]{43}$/.test(input.account || "")) throw new NativeStoreError("key_store_inputs");
 const body = JSON.stringify(input); if (Buffer.byteLength(body) > 16384) throw new NativeStoreError("key_store_inputs");
 const write = input.op !== "get";
 return new Promise((resolve, reject) => {
  let child, output = "", done = false, exited = false, stopping, timer, escalation, reap;
  const unavailable = () => new NativeStoreError(write ? "native_outcome_unknown" : "key_store_unavailable", child?.pid);
  function finish(error, value) {
   if (done) return; done = true; clearTimeout(timer); clearTimeout(escalation); clearTimeout(reap);
   child?.stdin?.destroy(); child?.stdout?.destroy();
   if (error?.code === "native_process_unreaped") child?.unref?.();
   error ? reject(error) : resolve(value);
  }
  function stop(error = unavailable()) {
   if (done || stopping) return; stopping = error;
   child?.stdin?.destroy();
   try { child?.kill(platform === "win32" ? "SIGKILL" : "SIGTERM"); } catch {}
   escalation = setTimeout(() => {
    if (done) return;
    try { child?.kill("SIGKILL"); } catch {}
    reap = setTimeout(() => finish(new NativeStoreError("native_process_unreaped", child?.pid)), graceMs);
   }, graceMs);
  }
  try {
   const env = { PATH: process.env.PATH, ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}) };
   child = spawnImpl(process.execPath, [fileURLToPath(new URL("./keyring-worker.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
   child.on("error", () => { if (!child.pid) finish(new NativeStoreError("key_store_unavailable")); else stop(); });
   child.on("exit", () => { exited = true; });
   child.stdout.on("data", chunk => { if (done) return; output += chunk; if (Buffer.byteLength(output) > 16384) stop(); });
   child.stdin.on("error", () => stop());
   child.on("close", code => {
    if (done) return;
    if (!exited && child.pid) { stop(); return; }
    if (stopping) { finish(stopping); return; }
    try {
     const value = JSON.parse(output);
     if (code || value.ok !== true || Object.keys(value).some(key => !["ok", "value"].includes(key))) throw Error();
     if (input.op === "get" && value.value !== null && typeof value.value !== "string") throw Error();
     finish(null, value.value);
    } catch { finish(unavailable()); }
   });
   timer = setTimeout(() => stop(), timeoutMs);
   // Durably record the broker PID before giving it private input.
   onSpawn?.(child.pid);
   child.stdin.end(body);
  } catch { if (child?.pid) stop(); else finish(new NativeStoreError("key_store_unavailable")); }
 });
}
