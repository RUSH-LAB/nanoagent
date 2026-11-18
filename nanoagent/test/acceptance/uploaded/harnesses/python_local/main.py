"""A harness with zero model calls: computes the probe's digest locally and writes the result atomically."""

import hashlib
import json
import os
import tempfile

with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
    request = json.load(source)
digest = hashlib.sha256(request["case"]["arguments"]["token"].encode()).hexdigest()[:12]
target = os.environ["RUSH_RESULT"]
descriptor, temporary = tempfile.mkstemp(dir=os.path.dirname(target))
with os.fdopen(descriptor, "w", encoding="utf-8") as out:
    json.dump({"protocol": "rush.harness.v1", "status": "answered", "answer": {"digest": digest}}, out)
os.rename(temporary, target)
