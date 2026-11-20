import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Duplex } from "node:stream";
import { fetchCheckedCallback, CALLBACK_RESPONSE_BYTES, type WakeConnect } from "../src/wake-target.ts";
const lookup=async()=>["1.2.3.4"];
test("callback refuses unsafe URLs, mixed DNS and unsafe headers before delivery",async()=>{
 let calls=0;const deliver=async()=>{calls++;return new Response("ok");};
 for(const url of ["http://example.com","https://user:pass@example.com","https://example.com:444/","https://example.com/#secret","https://127.0.0.1/","https://[::1]/"]) assert.equal((await fetchCheckedCallback(url,{}, {lookup,deliver})).ok,false,url);
 assert.equal((await fetchCheckedCallback("https://callback.example/",{}, {lookup:async()=>["1.2.3.4","10.0.0.1"],deliver})).ok,false);
 assert.equal((await fetchCheckedCallback("https://callback.example/",{headers:{authorization:"Bearer must-not-leak"}}, {lookup,deliver})).ok,false);
 assert.equal(calls,0);
});
test("callback pins one lookup, carries cancellation, refuses even same-origin redirects, bounds challenge body",async()=>{
 let looked=0;let delivered=0;
 const result=await fetchCheckedCallback("https://callback.example/a",{method:"POST",body:"{}"},{lookup:async()=>{looked++;return ["1.2.3.4"];},deliver:async(url,init,target)=>{delivered++;assert.equal(target.ip,"1.2.3.4");assert.equal(target.hostname,"callback.example");assert.equal(init.redirect,"manual");assert.ok(init.signal);return new Response(null,{status:307,headers:{location:"/b"}});}});
 assert.deepEqual(result,{ok:false,reason:"redirect"});assert.equal(looked,1);assert.equal(delivered,1);
 assert.deepEqual(await fetchCheckedCallback("https://callback.example/",{}, {lookup,deliver:async()=>new Response(new Uint8Array(CALLBACK_RESPONSE_BYTES+1))}),{ok:false,reason:"response_limit"});
 const ok=await fetchCheckedCallback("https://callback.example/",{}, {lookup,deliver:async()=>new Response('{"challenge":"test"}')});assert.equal(ok.ok,true);if(ok.ok)assert.equal(new TextDecoder().decode(ok.body),'{"challenge":"test"}');
});
test("callback aborts a stalled lookup before any connection",async()=>{
 const parent=new AbortController();let connections=0;
 const result=fetchCheckedCallback("https://callback.example/",{signal:parent.signal},{lookup:async()=>new Promise(()=>{}),deliver:async()=>{connections++;return new Response();}});
 parent.abort();assert.deepEqual(await result,{ok:false,reason:"timeout"});assert.equal(connections,0);
});
test("native callback socket is pinned and sends original TLS SNI; certificate failure never falls back",async()=>{
 const chunks:Buffer[]=[];let dialed="";
 const server=net.createServer(socket=>socket.on("data",chunk=>{chunks.push(chunk);if(Buffer.concat(chunks).length>100)socket.destroy();}));
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();if(!address||typeof address==="string")throw Error();
 const connect:WakeConnect=addr=>{
  dialed=addr.hostname;const socket=net.connect({host:"127.0.0.1",port:address.port});const web=Duplex.toWeb(socket);
  return {readable:web.readable,writable:web.writable,opened:new Promise((resolve,reject)=>{socket.once("connect",()=>resolve({remoteAddress:"127.0.0.1"}));socket.once("error",reject);}),async close(){socket.destroy();}};
 };
 try {const result=await fetchCheckedCallback("https://callback.example/",{method:"POST",body:"no plaintext before TLS"},{lookup,connect});assert.deepEqual(result,{ok:false,reason:"transport"});assert.equal(dialed,"1.2.3.4");const hello=Buffer.concat(chunks);assert.equal(hello.includes(Buffer.from("callback.example")),true);assert.equal(hello.includes(Buffer.from("POST /")),false);}finally{server.close();}
});
test("overall deadline includes response-body stall",async()=>{
 const start=Date.now();let canceled=false;
 const result=await fetchCheckedCallback("https://callback.example/",{}, {lookup,deliver:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){canceled=true;}}))});
 assert.deepEqual(result,{ok:false,reason:"timeout"});assert.ok(Date.now()-start<11500);
 // A transport obeys the propagated signal; the outer deadline also settles when a fixture ignores it.
 assert.equal(canceled,true);
});

test("MCP verification and event delivery preserve subscription/signing headers and serialized bytes",async()=>{
 let calls=0;
 for(const body of ['{"challenge":"one-time-fixture"}','{"eventId":"event-fixture","name":"message.received","data":{}}']){
  const result=await fetchCheckedCallback("https://callback.example/",{method:"POST",body,headers:{"Content-Type":"application/json","webhook-id":"occurrence-fixture","webhook-timestamp":"1234567890","webhook-signature":"v1,signature-fixture","X-MCP-Subscription-Id":"subscription-fixture"}},{lookup,deliver:async(_url,init)=>{calls++;const h=new Headers(init.headers);assert.equal(h.get("x-mcp-subscription-id"),"subscription-fixture");assert.equal(h.get("webhook-id"),"occurrence-fixture");assert.equal(h.get("webhook-timestamp"),"1234567890");assert.equal(h.get("webhook-signature"),"v1,signature-fixture");assert.equal(init.body,body);assert.equal(init.redirect,"manual");assert.ok(init.signal);return new Response('{"challenge":"one-time-fixture"}');}});
  assert.equal(result.ok,true);
 }
 assert.equal(calls,2);
 for(const name of ["authorization","cookie","host","x-mcp-subscription-secret"]){const result=await fetchCheckedCallback("https://callback.example/",{headers:{[name]:"fixture"}},{lookup,deliver:async()=>{throw Error("forbidden header reached transport");}});assert.deepEqual(result,{ok:false,reason:"target"});}
});
