// Only protected synthetic state and public ciphertext fixtures are read.
import fs from'node:fs';import{LocalState}from'../../local-state.mjs';import{DeliveryLedger}from'../../ledger.mjs';
const [dir,packet]=process.argv.slice(2),options=JSON.parse(fs.readFileSync(packet,'utf8')),state=new LocalState(dir,{write:true}),ledger=new DeliveryLedger(state);process.send({ready:true});
process.once('message',async()=>{try{const result=await ledger.acceptTask(options);process.send({ok:true,deliveries:result.deliveries});}catch(error){process.send({ok:false,code:error.code});}finally{state.close();process.disconnect();}});
