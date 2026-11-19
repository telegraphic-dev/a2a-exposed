import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { localSafetyCode, localSafetyEmoji } from "../local-state.mjs";
import { SAFETY_EMOJI, safetyEmojiFromHex } from "../safety-emoji.mjs";
const vectors = JSON.parse(fs.readFileSync(new URL("./safety-emoji-vectors.json", import.meta.url)));
test("independent Python SHA-256 vectors retain full code and ordered emoji across argument order", () => {
 for (const v of vectors) for (const [a,b] of [[v.a,v.b],[v.b,v.a]]) {
  assert.equal(localSafetyCode(a,b),v.code); assert.deepEqual(localSafetyEmoji(a,b),v.emoji);
  assert.deepEqual(safetyEmojiFromHex(v.fingerprint),v.emoji);
 }
 assert.equal(SAFETY_EMOJI.length,64); assert.equal(new Set(SAFETY_EMOJI.map(x=>x.name)).size,64);
 for(let i=0;i<64;i++) {
  const hex=(BigInt(i)<<250n).toString(16).padStart(64,"0");
  assert.deepEqual(safetyEmojiFromHex(hex)[0],SAFETY_EMOJI[i]);
 }
 assert.throws(()=>safetyEmojiFromHex(""));
 const copy=safetyEmojiFromHex("0".repeat(64));copy[0].name="changed";
 assert.equal(safetyEmojiFromHex("0".repeat(64))[0].name,"Dog");
});
