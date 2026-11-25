import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PEER_WAKE_POLICY as defaults, PEER_WAKE_EVENTS, PEER_WAKE_ACTIONS, validPeerWakePolicy, peerWakeEvent, peerWakeAction } from "../src/peer-wake-policy.ts";

test("complete policy validation refuses partial, unknown, array and invalid actions", () => {
 assert.equal(validPeerWakePolicy(defaults), true);
 for (const value of [null, [], {}, { ...defaults, extra: "wake" }, { ...defaults, ack: "always" }, { ...defaults, empty: undefined }]) assert.equal(validPeerWakePolicy(value), false);
});
test("defaults classify protocol states before untrusted intent", () => {
 for (const prefix of ["", "TASK_STATE_"]) {
  const state = (v: string) => prefix ? prefix + v.toUpperCase().replace(/-/g, "_") : v;
  assert.equal(peerWakeEvent(false, state("completed"), "", false, "ack"), "completed");
  for (const v of ["failed", "input-required"]) assert.equal(peerWakeEvent(false, state(v), "", false, "ack"), "attention");
  for (const v of ["working", "submitted"]) {
   assert.equal(peerWakeEvent(false, state(v), " \n", false, null), "empty");
   assert.equal(peerWakeEvent(false, state(v), "text", false, null), "update");
   assert.equal(peerWakeEvent(false, state(v), "", true, null), "update");
  }
 }
 assert.equal(peerWakeEvent(true, null, "hello", false, null), "inbound");
 assert.equal(peerWakeEvent(false, "unknown", "", false, null), "update");
 assert.equal(peerWakeEvent(true, null, "ok", false, "ack"), "ack");
});
test("owner choices override always while never and duplicate cannot wake or batch", () => {
 for (const event of PEER_WAKE_EVENTS) for (const action of PEER_WAKE_ACTIONS) {
  const policy = { ...defaults, [event]: action };
  for (const hint of [null, "auto", "always"]) assert.equal(peerWakeAction(policy, event, hint, false), action);
  assert.equal(peerWakeAction(policy, event, "never", false), "skip");
  assert.equal(peerWakeAction(policy, event, "always", true), "skip");
 }
 assert.deepEqual(defaults, { inbound: "wake", update: "wake", completed: "wake", attention: "wake", empty: "skip", ack: "skip" });
});
