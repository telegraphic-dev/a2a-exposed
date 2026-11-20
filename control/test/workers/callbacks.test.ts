import { test, expect } from "vitest";
import { fetchCheckedCallback, CALLBACK_TIMEOUT_MS } from "../../src/core/callbacks.ts";
test("workerd imports strict callback helper and fails closed for private/redirect/oversize targets",async()=>{
 expect(CALLBACK_TIMEOUT_MS).toBe(10000);
 expect((await fetchCheckedCallback("https://127.0.0.1/",{})).ok).toBe(false);
 const result=await fetchCheckedCallback("https://callback.example/",{}, {lookup:async()=>["1.2.3.4"],deliver:async()=>new Response(null,{status:302,headers:{location:"https://callback.example/b"}})});
 expect(result).toEqual({ok:false,reason:"redirect"});
 expect(await fetchCheckedCallback("https://callback.example/",{}, {lookup:async()=>["1.2.3.4"],deliver:async()=>new Response(new Uint8Array(16385))})).toEqual({ok:false,reason:"response_limit"});
});
