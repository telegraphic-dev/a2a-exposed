import test from 'node:test';
import assert from 'node:assert/strict';
import {createContinuationSourceSnapshot} from '../lib/continuation-sources.mjs';
const bytes=s=>s===null?null:Buffer.from(s);
const peer=(variable='PEER_ALPHA_TOKEN')=>({url:'https://example.com/alpha',token_env:variable});
const raw=(config='PEER_ALPHA_TOKEN=synthetic-file\n',peers=JSON.stringify({alpha:peer()}))=>({configEnv:bytes(config),peers:bytes(peers)});
const choose=(s,environment={})=>s.select({selected:['alpha'],excluded:[]},environment);
const refuse=fn=>assert.throws(fn,e=>e.code?.startsWith('continuation_'));

test('explicit credential selection matches nonempty environment precedence without trusting legacy paired metadata',()=>{
 const s=createContinuationSourceSnapshot(raw(undefined,JSON.stringify({alpha:{...peer(),token_stored:true,paired:{userCode:'synthetic-code',at:'2026-11-12T00:00:00Z',label:'synthetic label'}}})));
 assert.deepEqual(s.inspectInventory(),[{alias:'alpha',legacy_url:'https://example.com/alpha',credential_variable:'PEER_ALPHA_TOKEN'}]);
 assert.deepEqual(choose(s),[{alias:'alpha',legacy_url:'https://example.com/alpha',credential_variable:'PEER_ALPHA_TOKEN',credential_source:'file',token:'synthetic-file'}]);
 assert.equal(choose(s,{PEER_ALPHA_TOKEN:'synthetic-env'})[0].credential_source,'environment');assert.equal(choose(s,{PEER_ALPHA_TOKEN:''})[0].token,'synthetic-file');
 const equal=choose(s,{PEER_ALPHA_TOKEN:'synthetic-file'})[0];assert.equal(equal.credential_source,'environment');assert.ok(!Object.hasOwn(equal,'verified'));assert.ok(!Object.hasOwn(equal,'endpoint'));assert.ok(!Object.hasOwn(equal,'pairing_identity'));
});
test('strict env accepts serializer-compatible literal values and performs no shell expansion',()=>{
 const s=createContinuationSourceSnapshot(raw(' # comment\nexport PEER_ALPHA_TOKEN="literal $(never-run) ${HOME} \\u2603"\nEMPTY=\nSINGLE=\'literal value\'\n'));
 assert.equal(choose(s)[0].token,'literal $(never-run) ${HOME} ☃');assert.deepEqual(s.abandonmentValues(['EMPTY','MISSING','SINGLE'],{}),{environment:{},fileValues:{EMPTY:'',SINGLE:'literal value'}});
});
test('malformed or duplicate environment lines fail globally instead of using cached or empty config',()=>{
 for(const config of ['PEER_ALPHA_TOKEN=synthetic\nBAD LINE\n','PEER_ALPHA_TOKEN=a\nexport PEER_ALPHA_TOKEN=b\n','export 1BAD=value\n','PEER_ALPHA_TOKEN="unterminated\n',"PEER_ALPHA_TOKEN='bad'quote'\n",'PEER_ALPHA_TOKEN=unquoted space\n','PEER_ALPHA_TOKEN=${SHELL}\n','PEER_ALPHA_TOKEN=$(command)\n','PEER_ALPHA_TOKEN="a" trailing\n','PEER_ALPHA_TOKEN="\\u0000"\n','PEER_ALPHA_TOKEN="\\ud800"\n','PEER_ALPHA_TOKEN=abc\rBAD=x','\ufeffPEER_ALPHA_TOKEN=x\n'])refuse(()=>createContinuationSourceSnapshot(raw(config)));
});
test('duplicate JSON keys including escaped aliases and nested metadata fail before normalization',()=>{
 for(const source of ['{"alpha":{"url":"https://example.com/a","token_env":"PEER_ALPHA_TOKEN"},"alpha":{}}','{"alpha":{"url":"https://example.com/a","token_env":"PEER_ALPHA_TOKEN","token_env":"OTHER"}}','{"alpha":{"url":"https://example.com/a","token_env":"PEER_ALPHA_TOKEN","paired":{"userCode":"a","userCode":"b","at":"now"}}}','{"alpha":{},"\\u0061lpha":{}}','null','[]','{} trailing','{"alpha": {"url":"https://example.com/a","token_env":"PEER_ALPHA_TOKEN","extra":true}}'])refuse(()=>createContinuationSourceSnapshot(raw('PEER_ALPHA_TOKEN=x',source)));
});
test('UTF-8, size and bounded nesting checks refuse unsafe raw bytes without lossy decoding',()=>{
 for(const value of [Buffer.from([0xc0,0xaf]),Buffer.from([0xed,0xa0,0x80]),Buffer.from([0x00]),Buffer.alloc(1024*1024+1)])for(const field of ['configEnv','peers']){const input=raw();input[field]=value;refuse(()=>createContinuationSourceSnapshot(input));}
 refuse(()=>createContinuationSourceSnapshot(raw('', '{"alpha":'+ '['.repeat(34)+'0'+']'.repeat(34)+'}')));
 const input=raw();input.peers=Buffer.from('');refuse(()=>createContinuationSourceSnapshot(input));
});
test('complete explicit inventory partition is mandatory and selected/excluded sets cannot overlap',()=>{
 const s=createContinuationSourceSnapshot(raw('A=synthetic-a\nB=synthetic-b\n',JSON.stringify({alpha:peer('A'),beta:{url:'https://example.com/beta',token_env:'B'}})));
 const selected=s.select({selected:['alpha'],excluded:['beta']},{});assert.equal(selected.length,1);assert.equal(selected[0].alias,'alpha');
 for(const selection of [{selected:['alpha'],excluded:[]},{selected:['alpha'],excluded:['alpha','beta']},{selected:['alpha'],excluded:['gamma']},{selected:[],excluded:['alpha','beta']},{selected:['beta','alpha'],excluded:[]},{selected:['alpha','alpha'],excluded:['beta']}])refuse(()=>s.select(selection,{}));
});
test('alias normalization and shared explicit variables across omitted peers hold adoption',()=>{
 for(const peers of [{ 'peer-a':peer('A'),peer_a:peer('B')},{Alpha:peer('A'),alpha:peer('B')},{alpha:peer('A'),beta:peer('A')}]){
  const s=createContinuationSourceSnapshot(raw('A=synthetic-a\nB=synthetic-b\n',JSON.stringify(peers))),aliases=s.inspectInventory().map(p=>p.alias);refuse(()=>s.select({selected:[aliases[0]],excluded:aliases.slice(1)},{}));
 }
});
test('missing explicit variable, insecure/ambiguous URL and invalid legacy shapes are not adopted',()=>{
 for(const p of [{url:'https://example.com/alpha'},{...peer(),token_env:null},{...peer(),token_env:'NOT VALID'}, {...peer(),url:'http://example.com/a'},{...peer(),url:'https://user:pass@example.com/a'},{...peer(),url:'https://example.com/a?token=synthetic'},{...peer(),url:'https://example.com/a#part'},{...peer(),url:{toString:'not-callable'}},{...peer(),token_stored:'true'},{...peer(),paired:{}},{...peer(),paired:{userCode:'a',at:'now',verified:true}}])refuse(()=>createContinuationSourceSnapshot(raw('',JSON.stringify({alpha:p}))));
});
test('selected environment getters fail without invocation or fallback, unrelated getters are not read',()=>{
 const s=createContinuationSourceSnapshot(raw());let calls=0;const selected={};Object.defineProperty(selected,'PEER_ALPHA_TOKEN',{get(){calls++;return 'synthetic';}});refuse(()=>choose(s,selected));
 const other={};Object.defineProperty(other,'UNRELATED_SECRET',{get(){calls++;throw Error('must not read');}});assert.equal(choose(s,other)[0].token,'synthetic-file');assert.equal(calls,0);
 for(const value of [undefined,null,42,false,{},'bad\0value','\ud800'])refuse(()=>choose(s,{PEER_ALPHA_TOKEN:value}));
});
test('missing credentials stay absent for abandonment and never become fabricated empty or admission',()=>{
 const s=createContinuationSourceSnapshot(raw(null,null));assert.deepEqual(s.inspectInventory(),[]);assert.deepEqual(s.abandonmentValues(['PEER_ALPHA_TOKEN'],{}),{environment:{},fileValues:{}});refuse(()=>choose(s));
 const exists=createContinuationSourceSnapshot(raw('UNRELATED=literal\n'));refuse(()=>choose(exists));assert.deepEqual(exists.abandonmentValues(['PEER_ALPHA_TOKEN'],{PEER_ALPHA_TOKEN:''}),{environment:{PEER_ALPHA_TOKEN:''},fileValues:{}});
 const empty=createContinuationSourceSnapshot(raw('PEER_ALPHA_TOKEN=\n'));refuse(()=>choose(empty));assert.equal(choose(empty,{PEER_ALPHA_TOKEN:'synthetic-env'})[0].credential_source,'environment');
});
test('byte/source/selection getters run zero calls; original buffers and output mutations do not change snapshots',()=>{
 let calls=0;for(const field of ['configEnv','peers']){const input=raw();Object.defineProperty(input,field,{get(){calls++;return Buffer.alloc(0);}});refuse(()=>createContinuationSourceSnapshot(input));}
 for(const field of ['configEnv','peers'])for(const prototype of [Buffer,Uint8Array]){const input=raw(),value=prototype===Buffer?Buffer.from('test'):new Uint8Array([1,2,3,4]);Object.defineProperty(value,'length',{get(){calls++;return 4;}});input[field]=value;refuse(()=>createContinuationSourceSnapshot(input));}
 const input=raw(),s=createContinuationSourceSnapshot(input);input.configEnv.fill(0);input.peers.fill(0);assert.equal(choose(s)[0].token,'synthetic-file');s.inspectInventory()[0].alias='changed';choose(s)[0].token='changed';assert.equal(choose(s)[0].token,'synthetic-file');
 const selection={selected:['alpha'],excluded:[]};Object.defineProperty(selection,'selected',{get(){calls++;return ['alpha'];}});refuse(()=>s.select(selection,{}));assert.equal(calls,0);
});
test('fresh explicit environment snapshots retain source distinction across calls and expose no raw errors',()=>{
 const s=createContinuationSourceSnapshot(raw());assert.equal(choose(s,{PEER_ALPHA_TOKEN:'synthetic-env'})[0].token,'synthetic-env');assert.equal(choose(s,{})[0].token,'synthetic-file');
 const privateText='SYNTHETIC_PRIVATE_NEVER_ECHO';try{createContinuationSourceSnapshot(raw(privateText));assert.fail('must refuse');}catch(e){assert.equal(e.code,'continuation_source_invalid');assert.ok(!String(e).includes(privateText));assert.ok(!e.next.includes(privateText));}
});
