// Runs on Linux, macOS and Windows without native keychain access or consent prompts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { LocalState } from "../local-state.mjs";

function broaden(file) {
 if (process.platform !== "win32") { fs.chmodSync(file, 0o644); return; }
 // The SID avoids localized account names. Only this disposable fixture is changed.
 const script = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();$a=Get-Acl -LiteralPath $p;$sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');$r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $p -AclObject $a";
 execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {input:file, stdio:["pipe","ignore","pipe"], timeout:5000});
}
test("platform file custody survives restart and refuses broadened permissions without replacement", async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"a2a-platform-custody-"));
 let state;
 t.after(()=>{state?.close();fs.rmSync(dir,{recursive:true,force:true});});
 try { state=new LocalState(dir,{create:true}); }
 catch(error) {
  if(process.platform === "win32") {
   // Diagnose only the error identifier on a disposable fixture; never paths or key data.
   const source=fs.readFileSync(new URL("../local-state.mjs",import.meta.url),"utf8");
   const script=source.split('function protect(file) {')[1].split('const script = "')[1].split('";')[0].replace('catch{exit 1}', 'catch{[Console]::Out.Write($_.FullyQualifiedErrorId);exit 1}');
   try { execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{input:path.join(dir,"encryption"),stdio:["pipe","pipe","pipe"],timeout:5000}); }
   catch(probe) { t.diagnostic("Windows ACL fixture error identifier: "+String(probe.stdout)); }
  }
  throw error;
 }
 const created=await state.initialize({store:"file",cardUrl:"https://local.example.com/card"});
 const file=path.join(dir,"encryption",created.id+".key"),bytes=fs.readFileSync(file);
 state.close();state=new LocalState(dir);
 assert.equal((await state.loadIdentity(created.id)).bundle.keyId,created.bundle.keyId);
 const privateValue=JSON.parse(bytes);
 for(const key of [privateValue.signing,privateValue.encryption]) {
  assert.equal(JSON.stringify(state.status()).includes(key),false);
  assert.equal(fs.readFileSync(path.join(dir,"encryption","state.sqlite")).includes(Buffer.from(key)),false);
 }
 broaden(file);
 await assert.rejects(state.loadIdentity(created.id),{code:"key_store_permissions"});
 assert.deepEqual(fs.readFileSync(file),bytes,"refused custody does not replace the key");
 assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f=>f.endsWith(".key")),[created.id+".key"]);
});
