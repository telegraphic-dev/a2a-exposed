"""Independent JSON Schema engine check over public synthetic fixtures."""
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
root = Path(__file__).resolve().parents[1] / "schemas"
fixtures = json.loads(Path(sys.argv[1]).read_text())
resources = [json.loads(file.read_text()) for file in root.glob("*.schema.json")]
registry = Registry().with_resources([(value["$id"], Resource.from_contents(value)) for value in resources])
positive = negative = 0
for name, cases in [("content", [fixtures["message"], fixtures["snapshot"]]), ("envelope", [fixtures["envelope"]]), ("message-carrier", list(fixtures["carriers"].values())), ("assignment", [fixtures["receipt"]]), ("receipt-carrier", list(fixtures["receiptCarriers"].values())), ("assigned-carrier", list(fixtures["assignedCarriers"].values()))]:
    schema = json.loads((root / (name + ".schema.json")).read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=registry)
    for case in cases:
        validator.validate(case)
        positive += 1
        extra = dict(case, unexpected="must refuse")
        assert not validator.is_valid(extra)
        negative += 1
print(json.dumps({"ok": True, "engine": "jsonschema Draft202012Validator", "positive": positive, "extraFieldNegative": negative}))
carrier_schema = json.loads((root / "message-carrier.schema.json").read_text())
carrier_validator = Draft202012Validator(carrier_schema, registry=registry)
mutations = 0
for version, original in fixtures["carriers"].items():
    cases = []
    value = json.loads(json.dumps(original)); value["taskId"] = None; cases.append(value)
    for kind in ["header-extra", "version", "recipient", "signature"]:
        value = json.loads(json.dumps(original)); envelope = value["parts"][0]["data"]
        if kind == "header-extra": envelope["header"]["extra"] = "synthetic cleartext"
        elif kind == "version": envelope["v"] = 2
        elif kind == "recipient": envelope["recipient"] = {"unexpected": "shape"}
        else: envelope["signature"] = {"untrusted": "object"}
        cases.append(value)
    for value in cases:
        assert not carrier_validator.is_valid(value)
        mutations += 1
print(json.dumps({"nestedCarrierMutationsRejected": mutations}))

if "taskCarriers" in fixtures:
    task_schema = json.loads((root / "task-carrier.schema.json").read_text())
    Draft202012Validator.check_schema(task_schema)
    task_validator = Draft202012Validator(task_schema, registry=registry)
    task_positive = task_negative = 0
    for version, values in fixtures["taskCarriers"].items():
        for value in values:
            task_validator.validate(value)
            omitted_artifacts = dict(value)
            omitted_artifacts.pop("artifacts", None)
            task_validator.validate(omitted_artifacts)
            task_positive += 2
            assert not task_validator.is_valid(dict(value, unexpected="refuse"))
            task_negative += 1
        original = values[2]
        for mutation in ["status-extra", "state", "role", "part-extra", "header-extra", "version", "artifacts", "timestamp"]:
            value = json.loads(json.dumps(original))
            if mutation == "status-extra": value["status"]["extra"] = "refuse"
            elif mutation == "state": value["status"]["state"] = "UNKNOWN"
            elif mutation == "role": value["status"]["message"]["role"] = "user" if version == "0.3" else "ROLE_USER"
            elif mutation == "part-extra": value["status"]["message"]["parts"][0]["text"] = "leak"
            elif mutation == "header-extra": value["status"]["message"]["parts"][0]["data"]["header"]["extra"] = "leak"
            elif mutation == "version": value["status"]["message"]["parts"][0]["data"]["v"] = 2
            elif mutation == "artifacts": value["artifacts"] = [{"artifactId": "plaintext"}]
            else: value["status"]["timestamp"] = 123
            assert not task_validator.is_valid(value), mutation
            task_negative += 1
    print(json.dumps({"taskPositive": task_positive, "taskStructuralNegative": task_negative}))

if "capability" in fixtures:
    schema = json.loads((root / "capability.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=registry)
    validator.validate(fixtures["capability"])
    cases = [dict(fixtures["capability"], extra="refuse")]
    for kind in ["bundle-extra", "response-kind", "version"]:
        value = json.loads(json.dumps(fixtures["capability"]))
        if kind == "bundle-extra": value["params"]["bundle"]["extra"] = "refuse"
        elif kind == "response-kind": value["params"]["responseKind"] = "message"
        else: value["uri"] = value["uri"].replace("/v1", "/v2")
        cases.append(value)
    for value in cases:
        assert not validator.is_valid(value)
    print(json.dumps({"capabilityPositive": 1, "capabilityNegative": len(cases)}))
