# Foundation dependency review

Snapshot: 2026-11-12. The lockfile pins the complete resolved graph and registry
integrity hashes. Direct runtime dependencies are hpke-js `@hpke/core` 1.10.1,
`@hpke/dhkem-x25519` 1.8.1 and `@hpke/chacha20poly1305` 1.8.1. Their repository
is https://github.com/dajiaji/hpke-js and declared license is MIT. Transitive
`@hpke/common` is pinned in package-lock.json. No install scripts are needed.

The published [nonce-reuse advisory](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4)
affects core <=1.7.4 and is patched in 1.7.5; this package pins 1.10.1 and uses
one fresh context and one Seal per encrypted copy. `npm audit` reported zero
known advisories for this lockfile at review time. Neither a clean advisory
scan nor successful vectors constitutes an independent cryptographic audit.
No formal audit is asserted for this library or application construction.

Tests include the public RFC 9180 X25519/HKDF-SHA256/ChaCha20Poly1305 base
vector and local malformed/tampered input cases. Manual interop uses PyHPKE
0.6.5 over cryptography 50.0.2 to verify the envelope signature, open each copy
and check its commitment; these are test dependencies only, not package runtime
dependencies. They do not prove complete transport/trust/history integration.

Reproduce manual interop in an isolated Python environment with those versions:

```sh
node test/cross-language.mjs /private/new-disposable-fixture.json
python test/cross-language.py /private/new-disposable-fixture.json
```

The generator refuses existing files and writes disposable keys mode 600,
without printing them. Remove that generated fixture after the check; retain
only its result/provenance and these reproducible scripts. Never use real keys.
