import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/a2a-exposed.mjs', import.meta.url));
const defaults = {inbound:'wake',update:'wake',completed:'wake',attention:'wake',empty:'skip',ack:'skip'};
test('wake peers lists before explicit policy write and refuses incomplete choices without prompts', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'peer-wake-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const peerId='inbound:'+'a'.repeat(32), requests=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req) raw+=chunk;
  requests.push({method:req.method,path:req.url,body:raw?JSON.parse(raw):null});
  res.setHeader('content-type','application/json');
  if(new URL(req.url,'http://example.com').pathname!='/owner/wake/peers'){res.statusCode=404;res.end('{}');return;}
  res.end(JSON.stringify(req.method==='GET'?{defaults,events:Object.keys(defaults),actions:['wake','skip','batch'],peers:[{peerId,policy:defaults}]}:{peerId,policy:JSON.parse(raw).policy,configured:true}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const env={...process.env,DO_NOT_TRACK:'1',A2A_CONFIG_DIR:dir,A2A_BASE_URL:`http://127.0.0.1:${server.address().port}`,A2A_OWNER_TOKEN:'dummy-owner'};
 const run=args=>exec(process.execPath,[cli,'wake','peers',...args],{env,timeout:5000});
 const listed=JSON.parse((await run(['--json'])).stdout);assert.equal(listed.peers[0].peerId,peerId);
 const file=path.join(dir,'policy.json');fs.writeFileSync(file,JSON.stringify({...defaults,update:'batch'}));
 const saved=JSON.parse((await run(['--peer-id',peerId,'--policy-file',file,'--json'])).stdout);assert.equal(saved.policy.update,'batch');
 assert.deepEqual(requests.map(r=>r.method),['GET','GET','PUT']);
 for(const args of [['--peer-id',peerId],['--policy-file',file],['unexpected']]) await assert.rejects(run(args),e=>/wake peers/.test(e.stderr));
 assert.equal(requests.length,3);
 fs.writeFileSync(file,JSON.stringify({ack:'skip'}));await assert.rejects(run(['--peer-id',peerId,'--policy-file',file]),e=>/six event classes/.test(e.stderr));assert.equal(requests.length,3);
 fs.writeFileSync(file,JSON.stringify(defaults));await assert.rejects(run(['--peer-id','inbound:'+'b'.repeat(32),'--policy-file',file]),e=>/unknown or changed/.test(e.stderr));assert.deepEqual(requests.map(r=>r.method),['GET','GET','PUT','GET']);
});
