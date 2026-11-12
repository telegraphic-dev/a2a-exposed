// Only protected synthetic state and public ciphertext fixture files are read.
import fs from 'node:fs';
import {LocalState}from'../../local-state.mjs';
import {DeliveryLedger}from'../../ledger.mjs';
const [dir,packet]=process.argv.slice(2),options=JSON.parse(fs.readFileSync(packet,'utf8'));
const state=new LocalState(dir,{write:true}),ledger=new DeliveryLedger(state);process.send({ready:true});
process.once('message',async()=>{
 try{const result=await ledger.receiveInitial(options);process.send({ok:true,deliveryId:result.deliveryId,ackId:result.receipt.ackId,duplicate:result.duplicate});}
 catch(error){process.send({ok:false,code:error.code});}
 finally{state.close();process.disconnect();}
});
