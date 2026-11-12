// Manual cross-language fixture generator. Only disposable test keys; never real accounts.
import fs from "node:fs";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { generateIdentity, seal } from "../index.mjs";
if (process.argv.length !== 3) { console.error("Usage: node test/cross-language.mjs NEW_FIXTURE_FILE; run test/cross-language.py on that protected file, then remove it."); process.exit(1); }
const now = Date.parse("2026-11-12T00:00:00.000Z");
const a = await generateIdentity("https://alice.example.com/card", now), b = await generateIdentity("https://bob.example.com/card", now);
const content = { parts: [{ text: "cross-language canary" }], artifacts: [{ name: "synthetic attachment", parts: [{ data: { bytes: "c3ludGhldGlj" } }] }] };
const binding = { contextId: "context", messageId: "message", taskId: null, role: "user", state: null, kind: "message" };
const envelope = await seal({ identity: a, recipient: b.bundle, binding, content, now });
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const b64 = value => Buffer.from(value).toString("base64url");
const keys = [];
for (const identity of [a, b]) keys.push({ kty: "OKP", crv: "X25519", x: identity.bundle.encryptionKey, d: b64(await suite.kem.serializePrivateKey(identity.encryptionKey)) });
fs.writeFileSync(process.argv[2], JSON.stringify({ testOnly: true, envelope, content, sender: a.bundle, recipient: b.bundle, keys }) + "\n", { mode: 0o600, flag: "wx" });
console.log("Disposable interoperability fixture written mode 600; key bytes were not printed.");
