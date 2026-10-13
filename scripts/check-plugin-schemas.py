#!/usr/bin/env python3
"""Validate plugin manifests against pinned remote schemas.

The Agent Plugins schema is the published 1.0.0 document. The Cursor schema is
the file at a fixed commit. A SHA-256 pin rejects a silent change at that URL.
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parents[1]
PINS = (
    (
        "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        "0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883",
        jsonschema.Draft202012Validator,
        "plugin.json",
    ),
    (
        "https://raw.githubusercontent.com/cursor/plugins/5229aad76c37451561c5b81a9b5072ae1c549a5b/schemas/plugin.schema.json",
        "31db124b1c7e43c22abb13ebf7e7c74556482e480fd492b80638d815c85b96b1",
        jsonschema.Draft7Validator,
        ".cursor-plugin/plugin.json",
    ),
)


def fetch(url, digest):
    body = urllib.request.urlopen(url, timeout=30).read()
    got = hashlib.sha256(body).hexdigest()
    if got != digest:
        raise SystemExit(f"schema hash mismatch for {url}: {got}")
    return json.loads(body)


def main():
    for url, digest, validator, manifest in PINS:
        schema = fetch(url, digest)
        validator(schema).validate(json.loads((ROOT / manifest).read_text()))
        print(f"{manifest}: valid")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"check-plugin-schemas: {exc}", file=sys.stderr)
        sys.exit(1)
