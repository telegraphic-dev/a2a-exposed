import { test, expect } from "vitest";
import { fetchCheckedCallback, CALLBACK_TIMEOUT_MS } from "../../src/core/callbacks.ts";
test("workerd imports strict callback helper and fails closed for private/redirect/oversize targets",async()=>{
 expect(CALLBACK_TIMEOUT_MS).toBe(10000);
 expect((await fetchCheckedCallback("https://127.0.0.1/",{})).ok).toBe(false);
 const result=await fetchCheckedCallback("https://callback.example/",{}, {lookup:async()=>["1.2.3.4"],deliver:async()=>new Response(null,{status:302,headers:{location:"https://callback.example/b"}})});
 expect(result).toEqual({ok:false,reason:"redirect"});
 expect(await fetchCheckedCallback("https://callback.example/",{}, {lookup:async()=>["1.2.3.4"],deliver:async()=>new Response(new Uint8Array(16385))})).toEqual({ok:false,reason:"response_limit"});
});
test("workerd callback accepts required MCP subscription header without widening unrelated headers",async()=>{
 let calls=0;
 const result=await fetchCheckedCallback("https://callback.example/",{method:"POST",body:'{"challenge":"fixture"}',headers:{"X-MCP-Subscription-Id":"subscription-fixture","webhook-id":"event-fixture","webhook-timestamp":"1234567890","webhook-signature":"v1,fixture"}},{lookup:async()=>["1.2.3.4"],deliver:async(_url,init)=>{calls++;expect(new Headers(init.headers).get("x-mcp-subscription-id")).toBe("subscription-fixture");expect(init.body).toBe('{"challenge":"fixture"}');expect(init.redirect).toBe("manual");return new Response('{"challenge":"fixture"}');}});
 expect(result.ok).toBe(true);expect(calls).toBe(1);
 expect(await fetchCheckedCallback("https://callback.example/",{headers:{cookie:"must-not-leak"}},{lookup:async()=>["1.2.3.4"],deliver:async()=>{throw Error("must not deliver");}})).toEqual({ok:false,reason:"target"});
});
