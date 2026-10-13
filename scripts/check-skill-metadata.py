#!/usr/bin/env python3
"""Parse skill frontmatter and require the nested Hermes and OpenClaw metadata.

OpenClaw documents metadata.openclaw.envVars with boolean required
(https://docs.openclaw.ai/clawhub/skill-format). Hermes documents
metadata.hermes.tags and metadata.hermes.related_skills as lists
(https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills).
"""
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CLI_VERSION = json.loads((ROOT / "cli/package.json").read_text())["version"]


def fail(msg):
    print(f"check-skill-metadata: {msg}", file=sys.stderr)
    sys.exit(1)


def load(rel):
    text = (ROOT / rel).read_text()
    if not text.startswith("---\n"):
        fail(f"{rel} frontmatter does not start at byte 0")
    end = text.find("\n---\n", 4)
    if end < 0:
        fail(f"{rel} frontmatter does not close")
    try:
        data = yaml.safe_load(text[4:end])
    except yaml.YAMLError as exc:
        fail(f"{rel} frontmatter does not parse: {exc}")
    if not isinstance(data, dict):
        fail(f"{rel} frontmatter is not a mapping")
    return data


def strings(value, rel, label):
    if not isinstance(value, list) or not value or not all(isinstance(x, str) for x in value):
        fail(f"{rel} {label} must be a list of strings")
    return value


def check(rel, data):
    meta = data.get("metadata")
    if not isinstance(meta, dict):
        fail(f"{rel} metadata is missing")
    if any("." in str(key) for key in meta):
        fail(f"{rel} metadata uses dotted keys; Hermes and OpenClaw read nested maps")
    if meta.get("version") != CLI_VERSION:
        fail(f"{rel} metadata.version {meta.get('version')!r} != {CLI_VERSION}")
    hermes = meta.get("hermes")
    if not isinstance(hermes, dict):
        fail(f"{rel} metadata.hermes must be a nested map")
    strings(hermes.get("tags"), rel, "metadata.hermes.tags")
    related = strings(hermes.get("related_skills"), rel, "metadata.hermes.related_skills")
    openclaw = meta.get("openclaw")
    if not isinstance(openclaw, dict):
        fail(f"{rel} metadata.openclaw must be a nested map")
    bins = (openclaw.get("requires") or {}).get("bins")
    if bins != ["node"]:
        fail(f"{rel} metadata.openclaw.requires.bins must be [node]")
    env = openclaw.get("envVars")
    if not isinstance(env, dict) or not env:
        fail(f"{rel} metadata.openclaw.envVars must be a map")
    for name, spec in env.items():
        if not isinstance(spec, dict):
            fail(f"{rel} envVars.{name} must be a map")
        if not isinstance(spec.get("required"), bool):
            fail(f"{rel} envVars.{name}.required must be a boolean")
        if "sensitive" in spec and not isinstance(spec.get("sensitive"), bool):
            fail(f"{rel} envVars.{name}.sensitive must be a boolean")
        if not isinstance(spec.get("description"), str) or not spec["description"]:
            fail(f"{rel} envVars.{name}.description must be a string")
    return related


def main():
    day = check("skills/a2a-exposed/SKILL.md", load("skills/a2a-exposed/SKILL.md"))
    setup = check("skills/a2a-exposed-setup/SKILL.md", load("skills/a2a-exposed-setup/SKILL.md"))
    if "a2a-exposed-setup" not in day or "cloudflare" not in day:
        fail("a2a-exposed related_skills must include a2a-exposed-setup and cloudflare")
    for name in ("a2a-exposed", "mise", "cloudflare"):
        if name not in setup:
            fail(f"setup related_skills must include {name}")
    print("check-skill-metadata: nested hermes and openclaw metadata parses")


if __name__ == "__main__":
    main()
