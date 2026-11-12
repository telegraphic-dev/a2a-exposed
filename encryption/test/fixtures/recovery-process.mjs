// IPC controls only synthetic provider timing; private fixture bytes never leave this process.
import fs from 'node:fs';
import path from 'node:path';
import {LocalState} from '../../local-state.mjs';
const [dir,observation]=process.argv.slice(2);let release;
const state=new LocalState(dir,{write:true,keyring:async input=>{
 if(input.op!=='get')throw Error('unexpected synthetic provider operation');
 process.send({read_started:true});await new Promise(r=>release=r);
 return observation==='absent'?null:fs.readFileSync(path.join(dir,'mock-native.key'),'utf8');
}});
process.send({ready:true});
process.on('message',async message=>{
 if(message.release){release();return;}
 if(!message.start)return;
 try{await state.reconcileInitialization(message.options);process.send({done:true,ok:true});}
 catch(error){process.send({done:true,ok:false,code:error.code});}
 finally{state.close();process.disconnect();}
});
