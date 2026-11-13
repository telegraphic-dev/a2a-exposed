// Disabled fresh-table inventory check, not authority adoption or authentication.
// The future anchored caller must hold its own transaction and validate data.
import {createRequire} from 'node:module';
import {installContinuationProvenanceTables} from './continuation-provenance-tables.mjs';

const require=createRequire(import.meta.url);
export class ContinuationProvenanceInventoryError extends Error {
 constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new ContinuationProvenanceInventoryError(code);};
const inventory=db=>db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
let expected;
function expectedInventory(){
 if(expected===undefined){
  // Compare SQLite's own normalized schema text, including implicit indexes,
  // against an independent fresh in-memory installation of this exact format.
  // Never execute candidate SQL or create a reference file on disk.
  const {DatabaseSync}=require('node:sqlite'),reference=new DatabaseSync(':memory:');
  try{
   reference.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
   installContinuationProvenanceTables(reference);
   expected=JSON.stringify(inventory(reference));
  }finally{reference.close();}
 }
 return expected;
}

// Exact fresh foundation only: no schema-3/authority stores, attached schemas,
// TEMP shadows, extra objects or equivalent-but-different SQL are accepted.
// Success proves schema shape only, never trusted file identity or row contents.
// No physical initializer, command, signer writer or grant path imports this.
export function assertContinuationProvenanceInventory(db){
 if(db.isTransaction!==true)fail('continuation_inventory_transaction_required');
 if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('continuation_inventory_foreign_keys_required');
 if(db.prepare('PRAGMA trusted_schema').get().trusted_schema!==0)fail('continuation_inventory_untrusted_schema_required');
 for(const pragma of ['ignore_check_constraints','writable_schema'])if(db.prepare(`PRAGMA ${pragma}`).get()[pragma]!==0)fail('continuation_inventory_connection_invalid');
 if(db.prepare('PRAGMA main.user_version').get().user_version!==0)fail('continuation_inventory_version_mismatch');
 if(db.prepare('SELECT COUNT(*) n FROM temp.sqlite_schema').get().n!==0||db.prepare('PRAGMA database_list').all().some(row=>!['main','temp'].includes(row.name)))fail('continuation_inventory_namespace_mismatch');
 if(JSON.stringify(inventory(db))!==expectedInventory())fail('continuation_inventory_schema_mismatch');
 return Object.freeze({version:1,format:'fresh-continuation-provenance'});
}
