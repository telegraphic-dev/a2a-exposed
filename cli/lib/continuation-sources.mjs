// Internal source snapshot only: no filesystem/environment reads, approvals or grants.
const MAX=1024*1024,ALIAS=/^[A-Za-z0-9_-]{1,80}$/,VARIABLE=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const intrinsicLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'length').get;
export class ContinuationSourceError extends Error {
 constructor(code='continuation_source_invalid'){super(code);this.code=code;this.next='Preserve the source files. Inspect the exact peer inventory, select explicit aliases and excluded aliases, and relist after any source change. No grant or credential fallback was authorized.';}
}
const fail=code=>{throw new ContinuationSourceError(code);};
function object(v){if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail();}
function data(v,k){const d=Object.getOwnPropertyDescriptor(v,k);if(!d)return undefined;if(!Object.hasOwn(d,'value'))fail();return d.value;}
function exact(v,keys){object(v);const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail();for(const k of keys)if(!Object.hasOwn(v,k))fail();}
function text(v){if(typeof v!=='string'||v.includes('\0'))fail();for(const ch of v){const n=ch.codePointAt(0);if(n>=0xd800&&n<=0xdfff)fail();}return v;}
function decode(v){
 if(v===null)return null;
 if(!ArrayBuffer.isView(v)||![Buffer.prototype,Uint8Array.prototype].includes(Object.getPrototypeOf(v)))fail();
 const length=intrinsicLength.call(v);if(length>MAX||Reflect.ownKeys(v).length!==length)fail();
 const bytes=Buffer.alloc(length);try{
  for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!Object.hasOwn(d,'value'))fail();bytes[i]=d.value;}
  // Preserve a leading BOM so strict syntax rejects it rather than normalizing bytes.
  let result;try{result=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail();}return text(result);
 }finally{bytes.fill(0);}
}
function parseJSON(source){
 let result;try{result=JSON.parse(source);}catch{fail();}
 const tokens=source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)||[];let offset=0;
 function walk(depth){
  if(depth>32)fail();const token=tokens[offset++];
  if(token==='{'){
   const seen=new Set();if(tokens[offset]==='}'){offset++;return;}
   for(;;){const key=JSON.parse(tokens[offset++]);text(key);if(seen.has(key))fail();seen.add(key);offset++;walk(depth+1);if(tokens[offset++]==='}')return;}
  }
  else if(token==='['){if(tokens[offset]===']'){offset++;return;}for(;;){walk(depth+1);if(tokens[offset++]===']')return;}}
  else if(token?.startsWith('"'))text(JSON.parse(token));
  else if(!['true','false','null'].includes(token)&&!Number.isFinite(Number(token)))fail();
 }
 walk(0);return result;
}
function env(source){
 const values=new Map();if(source===null)return values;
 for(const raw of source.split(/\r?\n/)){
  const line=raw.replace(/^[ \t]+|[ \t]+$/g,'');if(!line||line.startsWith('#'))continue;
  const m=/^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line);if(!m||values.has(m[1]))fail();
  let value=m[2];if(value.startsWith('"')){value=parseJSON(value);if(typeof value!=='string')fail();}
  else if(value.startsWith("'")){if(value.length<2||!value.endsWith("'")||value.slice(1,-1).includes("'"))fail();value=value.slice(1,-1);}
  else if(!/^[A-Za-z0-9_./:@+,-]*$/.test(value))fail();
  text(value);values.set(m[1],value);
 }
 return values;
}
function inventory(source){
 if(source===null)return[];const peers=parseJSON(source);object(peers);const records=[];
 for(const [alias,record]of Object.entries(peers)){
  if(!ALIAS.test(alias))fail();object(record);const keys=Object.keys(record);if(keys.some(k=>!['url','token_env','token_stored','paired'].includes(k))||!keys.includes('url')||!keys.includes('token_env'))fail();
  const url=record.url,variable=record.token_env;if(typeof variable!=='string'||!VARIABLE.test(variable)||typeof url!=='string'||url.length>4096)fail();
  let parsed;try{parsed=new URL(url);}catch{fail();}if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash||parsed.search||!(parsed.href===url||parsed.pathname==='/'&&parsed.href===url+'/'))fail();
  if(Object.hasOwn(record,'token_stored')&&typeof record.token_stored!=='boolean')fail();
  if(Object.hasOwn(record,'paired')){const paired=record.paired;object(paired);if(Object.keys(paired).some(k=>!['userCode','at','label'].includes(k))||!Object.hasOwn(paired,'userCode')||!Object.hasOwn(paired,'at'))fail();for(const value of Object.values(paired))if(typeof value!=='string'||value.length>512)fail();}
  // Legacy metadata is deliberately not returned as verified pairing evidence.
  records.push({alias,legacy_url:url,credential_variable:variable});
 }
 if(records.length>1000)fail();return records.sort((a,b)=>Buffer.compare(Buffer.from(a.alias),Buffer.from(b.alias)));
}
function list(value,pattern){
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>1000||Reflect.ownKeys(value).length!==value.length+1)fail();
 const result=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'||!pattern.test(d.value)||i&&Buffer.compare(Buffer.from(result[i-1]),Buffer.from(d.value))>=0)fail();result.push(d.value);}return result;
}
function captureEnvironment(variables,environment){
 object(environment);const values=new Map();for(const variable of variables){const v=data(environment,variable);if(v===undefined){if(Object.hasOwn(environment,variable))fail();continue;}text(v);if(Buffer.byteLength(v)>MAX)fail();values.set(variable,v);}return values;
}
function publicMap(values){return Object.fromEntries(values);}
export function createContinuationSourceSnapshot(input){
 exact(input,['configEnv','peers']);const configEnv=decode(data(input,'configEnv')),peersText=decode(data(input,'peers')),fileValues=env(configEnv),peers=inventory(peersText);
 return{
  // Private source texts are only for the keyed source fingerprint, not tool output.
  sourceTexts(){return{configEnv,peers:peersText};},
  inspectInventory(){return peers.map(p=>({...p}));},
  select(selection,environment){
   exact(selection,['selected','excluded']);const selected=list(data(selection,'selected'),ALIAS),excluded=list(data(selection,'excluded'),ALIAS);if(!selected.length)fail('continuation_selection_required');
   const all=[...selected,...excluded];if(new Set(all).size!==all.length||all.length!==peers.length||peers.some(p=>!all.includes(p.alias)))fail('continuation_inventory_mismatch');
   // Conservative: ambiguous aliases/shared variables anywhere in this inventory hold adoption.
   const normalized=new Set(),variables=new Set();for(const p of peers){const name=p.alias.toUpperCase().replace(/[^A-Z0-9]/g,'_');if(normalized.has(name)||variables.has(p.credential_variable))fail('continuation_credential_ambiguous');normalized.add(name);variables.add(p.credential_variable);}
   if(configEnv===null||peersText===null)fail('continuation_source_missing');
   const chosen=peers.filter(p=>selected.includes(p.alias)),ambient=captureEnvironment(chosen.map(p=>p.credential_variable),environment);
   return chosen.map(p=>{const fromEnvironment=ambient.get(p.credential_variable),saved=fileValues.get(p.credential_variable),credential_source=fromEnvironment!==undefined&&fromEnvironment!==''?'environment':'file',token=credential_source==='environment'?fromEnvironment:saved;if(token===undefined||token==='')fail('continuation_credential_missing');return{...p,credential_source,token};});
  },
  // Missing original credentials are representable ONLY as no-grant observations.
  abandonmentValues(variableList,environment){const variables=list(variableList,VARIABLE),ambient=captureEnvironment(variables,environment);return{environment:publicMap(ambient),fileValues:publicMap(variables.filter(v=>fileValues.has(v)).map(v=>[v,fileValues.get(v)]))};}
 };
}
