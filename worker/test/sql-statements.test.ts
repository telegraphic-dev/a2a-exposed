import { test } from "node:test";
import assert from "node:assert/strict";
import { sqlStatements } from "./sql-statements.ts";
test("migration batching preserves triggers, CASE, quoted semicolons and comments",()=>{
 const input="-- ignored ;\nCREATE TRIGGER t AFTER INSERT ON p BEGIN UPDATE q SET x=CASE WHEN 1 THEN 'a;END' ELSE 'b' END; INSERT INTO r VALUES ('it''s;ok'); END; /* ; */ SELECT 1;";
 const out=sqlStatements(input);assert.equal(out.length,2);assert.match(out[0]!,/INSERT INTO r/);assert.equal(out[1],"SELECT 1;");
});
