"""Independent envelope opening with PyHPKE 0.6.5/cryptography 50.0.2. Test keys only."""
import base64
import hashlib
import json
import sys
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pyhpke import CipherSuite, KEMId, KDFId, AEADId, KEMKey


def raw(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def canonical(value):
    # This test fixture uses ASCII member names and integer-free header values.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def main():
    if len(sys.argv) != 2:
        print("Usage: python test/cross-language.py FIXTURE_FILE", file=sys.stderr)
        return 1
    fixture = json.loads(Path(sys.argv[1]).read_text())
    assert fixture["testOnly"] is True
    envelope = fixture["envelope"]
    body = {key: value for key, value in envelope.items() if key != "signature"}
    Ed25519PublicKey.from_public_bytes(raw(fixture["sender"]["identityKey"])).verify(
        raw(envelope["signature"]), b"a2a-exposed sealed envelope v1\n" + canonical(body)
    )
    suite = CipherSuite.new(KEMId.DHKEM_X25519_HKDF_SHA256, KDFId.HKDF_SHA256, AEADId.CHACHA20_POLY1305)
    for purpose, index in [("sender", 0), ("recipient", 1)]:
        copy = envelope[purpose]
        receiver = suite.create_recipient_context(
            raw(copy["enc"]), KEMKey.from_jwk(fixture["keys"][index]),
            info=b"a2a-exposed sealed v1 " + purpose.encode("ascii")
        )
        payload = json.loads(receiver.open(raw(copy["ct"]), canonical(envelope["header"])))
        assert payload["content"] == fixture["content"]
        commitment = hashlib.sha256(raw(payload["nonce"]) + canonical(payload["content"])).digest()
        assert commitment == raw(envelope["header"]["commitment"])
    print("PASS: independent Python verified signature, sender copy, recipient copy and both commitments.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("Interoperability check failed; fixture material was not printed.", file=sys.stderr)
        sys.exit(1)
