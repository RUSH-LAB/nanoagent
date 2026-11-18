"""Regenerates benchmark-prompt-parity.json from the real Python functions: cd nanoagent && .venv/bin/python <this file> > <that file>.

Each sample's `input_json` is its task and arguments as `json.dumps` wrote them, because the numbers' spelling (`1.0`, `1e-05`)
is what a JSON file read by JavaScript would lose; a test parses it as the server parses a publication."""
import json, sys
from pathlib import Path
from types import SimpleNamespace
import yaml
from nanoagent.plugin.tasks import task_prompt, decide_prompt

prompt = yaml.safe_load(Path("examples/benchmark/configs/step2_single_run.yaml").read_text())["prompt"]
cases = [
    {
        "plugin_name": "city-weather",
        "task": {"kind": "agent", "description": "Report the weather for a city", "instructions": "Look the city up.\nBe exact: é中😀",
                 "input_schema": {"type": "object", "required": ["city"], "properties": {"city": {"type": "string"}, "days": {"type": "integer"}}},
                 "output_schema": {"type": "object", "properties": {"temp_c": {"type": "number"}, "summary": {"type": "string"}}, "required": ["temp_c"]}},
        "context": "  Weather data is daily. \n\nUse UTC.  \n",
        "arguments": {"city": "Zürich", "days": 3, "tags": ["a", {"z": 1, "b": []}], "empty": {}, "none": None, "flag": True, "n": -2.5},
    },
    {
        "plugin_name": "market-check",
        "task": {"kind": "decide", "description": "Pick the trade", "instructions": "Prefer {braces} and 100% safety.",
                 "input_schema": {"type": "object"}, "output_schema": {"type": "object"}},
        "context": "",
        "arguments": {"symbol": "ÀÉ", "window": {"to": "2026-01-02", "from": "2026-01-01"}},
    },
]
edge = {
    "plugin_name": "edge-cases",
    "task": {"kind": "agent", "description": "Handle \"quotes\", \\ and é", "instructions": "Mind the numbers.",
             "input_schema": {"type": "object", "properties": {"ratio": {"type": "number", "minimum": 0.0, "maximum": 1e16, "default": 1.5e-05},
                                                                "items": {"type": "array", "items": {}, "maxItems": 10}}, "additionalProperties": False},
             "output_schema": {"type": "object", "properties": {}, "required": [], "examples": [{}, [], [[]], [{}]]}},
    "context": "\x1c\x85 \n\u00a0Unicode: é 中 😀 \u007f \u2028 end \u3000\n\ufeff",
    "arguments": {
        "z_last": 1, "a_first": 2, "Ünï": "çödé", "empty_list": [], "empty_map": {}, "nested": [[], {}, [{}], {"k": []}],
        "floats": [1.0, -1.0, 0.0, -0.0, 0.1, 2.5, 1e-05, 1e-07, 0.0001, 0.00001234, 1e15, 1e16, 1.5e16, 1e22, 1.7976931348623157e308,
                   5e-324, 123456789.123456789, 9007199254740992.0, 0.30000000000000004, 100.0],
        "ints": [0, -7, 9007199254740993, 12345678901234567890, 10**30, -(10**25)],
        "strings": ["tab\t", "nl\n", "cr\r", "bs\b", "ff\f", "ctl\u0001\u001f", "quote\"", "slash\\", "/", "\u007f", "\u2028\u2029", "\ud7ff\ue000\uffff", "😀🎉", "中文", "{braces} {{x}} 100%"],
        "bools": [True, False, None],
    },
}
cases.append(edge)
out = []
for case in cases:
    task = case["task"]
    manifest = SimpleNamespace(name=case["plugin_name"])
    definition = SimpleNamespace(description=task["description"], instructions=task["instructions"])
    coding = prompt.format(
        description=task["description"], context=case["context"].strip(),
        arguments=json.dumps(case["arguments"], indent=2),
        input_schema=json.dumps(task["input_schema"], indent=2),
        output_schema=json.dumps(task["output_schema"], indent=2),
        workspace=Path("/rush/workspace"),
    )
    if task["kind"] == "decide":
        tools = {"system": decide_prompt(manifest, definition), "user": None}
    else:
        system, user = task_prompt(manifest, definition, case["arguments"])
        tools = {"system": system, "user": user}
    out.append({**{k: v for k, v in case.items() if k not in ("task", "arguments")}, "kind": task["kind"], "input_json": json.dumps({"task": task, "arguments": case["arguments"]}), "coding": coding, "task_tools": tools,
                "custom_template": "Do {description} in {workspace} {{ok}}: {arguments}",
                "custom_coding": "Do {description} in {workspace} {{ok}}: {arguments}".format(description=task["description"], workspace=Path("/rush/workspace"), arguments=json.dumps(case["arguments"], indent=2))})
json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
