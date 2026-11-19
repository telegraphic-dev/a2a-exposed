import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSafetyEmoji, comparisonGuidance } from "../lib/sealed-keys.mjs";
test("missing emoji uses honest full-code comparison guidance, never invented symbols", () => {
 assert.equal(formatSafetyEmoji(null),"(unavailable)");
 assert.match(comparisonGuidance(null),/Emoji are unavailable.*full safety code.*other owner.*full numeric code/s);
 assert.doesNotMatch(comparisonGuidance(null),/Compare all seven/);
 const items=Array.from({length:7},()=>({emoji:"🐶",name:"Dog"}));
 assert.match(comparisonGuidance(items),/Compare all seven emoji and their names, in order/);
 assert.equal(formatSafetyEmoji(items).split(" · ").length,7);
});
