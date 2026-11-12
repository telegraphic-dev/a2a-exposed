import fs from'node:fs';import path from'node:path';import{initializePairingAuthority,withPairingAuthorityLease,mutatePairingAuthority,quarantinePairingAuthority}from'../../lib/pairing-authority.mjs';
const [dir,configIdentity,mode,packet]=process.argv.slice(2);
if(mode==='lease'){
 await withPairingAuthorityLease(dir,{configIdentity},async revision=>{process.send({held:true,revision});await new Promise(resolve=>process.once('message',resolve));});process.send({done:true});process.disconnect();
}else if(mode==='crash'){
 mutatePairingAuthority(dir,{configIdentity,expectedRevision:0},()=>{fs.writeFileSync(path.join(dir,'config.env'),'PEER_SYNTHETIC_TOKEN=synthetic-new-value\n',{mode:0o600});process.exit(0);});
}

else if(mode==='recover'){
 const options=JSON.parse(fs.readFileSync(packet,'utf8'));process.send({held:true});process.once('message',()=>{try{const result=quarantinePairingAuthority(dir,options);process.send({ok:true,revision:result.revision});}catch(error){process.send({ok:false,code:error.code});}finally{process.disconnect();}});
}

else if(mode==='init'){
 process.send({ready:true});process.once('message',()=>{try{const result=initializePairingAuthority(dir,{configIdentity});process.send({ok:true,configIdentity:result.configIdentity});}catch(error){process.send({ok:false,code:error.code});}finally{process.disconnect();}});
}
