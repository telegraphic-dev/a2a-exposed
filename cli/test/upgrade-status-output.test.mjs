import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectedMigrations } from "../lib/update.mjs";
const bin=fileURLToPath(new URL('../bin/a2a-exposed.mjs',import.meta.url)),stub=fileURLToPath(new URL('./fetch-stub.mjs',import.meta.url));
const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url))).version;
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a2a-schema-output-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const routes=path.join(dir,'routes.json'),base='https://agent.example.com';
 fs.writeFileSync(path.join(dir,'config.env'),`A2A_BASE_URL=${base}\nA2A_OWNER_TOKEN=fixture-owner\nA2A_WORKER_NAME=fixture\nA2A_D1_ID=fixture\n`,{mode:0o600});
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(A2A_|WAKE_|PEER_|CF_|CLOUDFLARE_|UPSTREAM_|CONTROL_|HOSTED_)/.test(k)));
 Object.assign(env,{A2A_CONFIG_DIR:dir,XDG_CACHE_HOME:dir,A2A_TEST_FETCH_ROUTES:routes,DO_NOT_TRACK:'1',CI:'1'});
 return (workerVersion,schema,json=true,latest=version)=>{
  fs.mkdirSync(path.join(dir,'a2a-exposed'),{recursive:true});fs.writeFileSync(path.join(dir,'a2a-exposed/update-check.json'),JSON.stringify({latest,checkedAt:Date.now()}));
  fs.writeFileSync(routes,JSON.stringify({[base+'/owner/']:{status:200,body:{configured:false,preset:'generic',pendingCount:0,pending:[]}},[base+'/owner/upgrade-status']:{status:200,body:{version:workerVersion,management:'self-hosted',schema}},[base+'/health']:{status:200,body:{ok:true,version:workerVersion}},[base+'/.well-known/agent-card.json']:{status:200,body:{name:'Fixture',supportedInterfaces:[{url:base,protocolVersion:'1.0',protocolBinding:'JSONRPC'}]}}}));
  return spawnSync(process.execPath,['--import',stub,bin,'status',...(json?['--json']:[])],{env,encoding:'utf8'});
 };
}
test('status fails known target schema before wake guidance and labels both build baselines in human/JSON',t=>{
 const cli=fixture(t),expected=expectedMigrations(),applied=expected.slice(0,-3),missing=expected.slice(-3);
 const current={status:'known',expected,applied,pending:missing};
 const r=cli(version,current);assert.equal(r.status,1,r.stderr);const data=JSON.parse(r.stdout);
 assert.equal(data.ok,false);assert.match(data.nextStep,/3 known pending.*ask the owner before running/);
 assert.equal(data.upgrade.schema.baseline,'deployed-build');assert.equal(data.upgrade.schema.version,version);
 assert.deepEqual(data.targetMigrations.pending,missing);assert.equal(data.targetMigrations.baseline,'cli-build');
 const older={status:'known',expected:applied,applied,pending:[]};
 const cross=JSON.parse(cli('0.8.20',older,true,'9.9.9').stdout),update=cross.update.find(r=>r.component==='worker');
 assert.deepEqual(cross.upgrade.schema.pending,[]);assert.equal(cross.upgrade.schema.version,'0.8.20');
 assert.deepEqual(update.pendingMigrations,missing);assert.equal(update.pendingMigrationBaseline,'cli-build');assert.equal(update.pendingMigrationVersion,version);
 const human=cli('0.8.20',older,false);assert.equal(human.status,1);
 assert.match(human.stdout,/Worker migrations \(deployed build 0.8.20\):\s+\d+ applied; 0 pending/);
 assert.match(human.stdout,new RegExp(`Worker migrations \\(CLI build ${version.replaceAll('.','\\.')}\\):\\s+3 pending`));
 const unknown=JSON.parse(cli(version,{status:'unknown',applied:null,pending:null}).stdout);
 assert.equal(unknown.targetMigrations.status,'unknown');assert.equal(unknown.targetMigrations.pending,null);assert.doesNotMatch(unknown.nextStep,/known pending/);
});
