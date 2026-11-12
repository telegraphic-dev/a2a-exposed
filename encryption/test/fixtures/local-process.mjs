// Disposable-process regression harness. No native credential provider is loaded.
import fs from 'node:fs';
import path from 'node:path';
import { LocalState } from '../../local-state.mjs';
const [dir, mode, localId] = process.argv.slice(2);
const state = new LocalState(dir, { create:true, keyring:async input => {
 if (input.op === 'set') {
  fs.writeFileSync(path.join(dir,'mock-native.key'),input.value,{mode:0o600,flag:'wx'});
  process.exit(77); // Crash after external write, before identity transaction.
 }
 throw Error('unexpected mock operation');
}});
const rotation = mode === "rotate" ? { id:localId, approvalDigest:state.rotationPlan(localId).approval_digest, ownerApproved:true } : null;
process.send({ready:true});
process.once('message',async () => {
 try {
  const result=rotation ? await state.rotateLocal(rotation) : await state.initialize({store:mode==='crash'?'keychain':'file',allowOsConsent:mode==='crash',cardUrl:'https://local.example.com/card'});
  process.send({ok:true,id:result.id});
 } catch(error) { process.send({ok:false,code:error.code}); }
 finally { state.close();process.disconnect(); }
});
