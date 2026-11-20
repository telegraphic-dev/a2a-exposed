/** Test D1 batching preserves SQLite trigger bodies, quoted semicolons and comments. */
export function sqlStatements(sql: string): string[] {
 const out:string[]=[];let query="";let depth=0;let i=0;
 while(i<sql.length){
  if(sql.slice(i,i+2)==="--"){while(i<sql.length&&sql[i]!=="\n")i++;query+="\n";continue;}
  if(sql.slice(i,i+2)==="/*"){const end=sql.indexOf("*/",i+2);if(end<0)throw Error("unclosed SQL comment");i=end+2;query+=" ";continue;}
  const c=sql[i]!;
  if(c==="'"||c==='"'||c==='`'||c==='['){
   const close=c==='['?']':c;query+=c;i++;
   while(i<sql.length){const q=sql[i++]!;query+=q;if(q===close){if(sql[i]===close){query+=sql[i++];continue;}break;}}
   continue;
  }
  if(/[A-Za-z_]/.test(c)){
   const start=i++;while(i<sql.length&&/[A-Za-z_0-9]/.test(sql[i]!))i++;
   const word=sql.slice(start,i);query+=word;
   if(/^\s*CREATE\s+TRIGGER\b/i.test(query)){if(/^(BEGIN|CASE)$/i.test(word))depth++;else if(/^END$/i.test(word))depth--;}
   continue;
  }
  query+=c;i++;
  if(c===';'&&depth===0){if(query.trim())out.push(query.trim());query="";}
 }
 if(depth!==0)throw Error("unclosed SQL trigger");if(query.trim())out.push(query.trim());return out;
}
