import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { safetyCode, safetyEmoji, requestSafetyEmoji } from "../src/sealed-keys.ts";
import { SAFETY_EMOJI, safetyEmojiFromHex } from "../src/safety-emoji.ts";
import { SAFETY_EMOJI as localTable } from "../../encryption/safety-emoji.mjs";
const vectors = JSON.parse(fs.readFileSync(new URL("../../encryption/test/safety-emoji-vectors.json", import.meta.url),"utf8"));
test("Worker matches independent canonical-fingerprint emoji and unchanged numeric vectors", async () => {
 assert.deepEqual(SAFETY_EMOJI,localTable);
 for(const v of vectors) for(const [a,b] of [[v.a,v.b],[v.b,v.a]]) {
  assert.equal(await safetyCode(a,b),v.code); assert.deepEqual(await safetyEmoji(a,b),v.emoji);
  assert.deepEqual(await requestSafetyEmoji({sealed_requester:JSON.stringify(a),sealed_responder:JSON.stringify(b)}),v.emoji);
 }
 assert.equal(await requestSafetyEmoji({}),null);
 assert.equal(await requestSafetyEmoji({sealed_requester:"bad",sealed_responder:"{}"}),null);
 for(let i=0;i<64;i++) assert.deepEqual(safetyEmojiFromHex((BigInt(i)<<250n).toString(16).padStart(64,"0"))[0],SAFETY_EMOJI[i]);
});
