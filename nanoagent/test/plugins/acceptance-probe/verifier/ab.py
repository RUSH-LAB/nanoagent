"""ab_reference (the ab-report task's reference) and the ab-report task's graded state."""

import hashlib
import json
from pathlib import Path

from .checks import result

CHECKS = ("outcome_exists", "schema_valid", "values_match", "side_effects", "no_extra_changes")
WINNERS = ("A", "B", "tie")
# answer.json is the outcome seam's file, written beside the declared output.
ANSWER = "answer.json"


def verify_input(value):
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    return result(True, "reference is whatever the staged files give")


def verify_task(arguments, output, reference, workspace):
    root = Path(workspace)
    steps = (
        lambda: _outcome_exists(arguments, root),
        lambda: _schema_valid(arguments, root),
        lambda: _values_match(arguments, reference, root),
        lambda: _side_effects(arguments, reference, root),
        lambda: _no_extra_changes(arguments, reference, root),
    )
    checks = []
    failure = None
    for name, step in zip(CHECKS, steps):
        if failure is not None:
            checks.append({"name": name, "status": "skipped", "message": "an earlier check failed"})
            continue
        message = step()
        checks.append({"name": name, "status": "passed" if message is None else "failed", "message": message or "ok"})
        failure = message
    return result(failure is None, "every check passed" if failure is None else failure, checks=checks)


def _outcome_exists(arguments, root):
    if not (root / arguments.output_path).is_file():
        return f"{arguments.output_path} is not in the workspace"
    return None


def _record(arguments, root):
    """The parsed record, or the reason it is not one."""
    try:
        record = json.loads((root / arguments.output_path).read_text())
    except ValueError as error:
        return None, f"{arguments.output_path} is not valid JSON: {error}"
    if not isinstance(record, dict) or set(record) != {"scenarios", "winner"}:
        return None, 'the record must be an object with exactly "scenarios" and "winner"'
    if record["winner"] not in WINNERS:
        return None, f'"winner" must be one of {", ".join(WINNERS)}'
    scenarios = record["scenarios"]
    if not isinstance(scenarios, list):
        return None, '"scenarios" must be a list'
    for entry in scenarios:
        if not isinstance(entry, dict) or set(entry) != {"scenario", "a_percent", "b_percent"}:
            return None, 'each scenario must be an object with exactly "scenario", "a_percent" and "b_percent"'
        if not isinstance(entry["scenario"], str):
            return None, '"scenario" must be a string'
        for field in ("a_percent", "b_percent"):
            value = entry[field]
            if isinstance(value, bool) or not isinstance(value, int | float) or not 0 <= value <= 100:
                return None, f'"{field}" of {entry["scenario"]!r} must be a number from 0 to 100'
    return record, None


def _schema_valid(arguments, root):
    return _record(arguments, root)[1]


def _values_match(arguments, reference, root):
    record = _record(arguments, root)[0]
    expected = {rate.scenario: rate for rate in reference.rates}
    given = [entry["scenario"] for entry in record["scenarios"]]
    for scenario in given:
        if scenario in reference.empty_scenarios:
            return f"scenario {scenario!r} has no rows and must be left out"
        if scenario not in expected:
            return f"scenario {scenario!r} is not one of the scenarios"
    if len(set(given)) != len(given) or set(given) != set(expected):
        return f"the record's scenarios {sorted(given)} are not {sorted(expected)}"
    for entry in record["scenarios"]:
        rate = expected[entry["scenario"]]
        for field, wanted in (("a_percent", rate.a_percent), ("b_percent", rate.b_percent)):
            if abs(entry[field] - wanted) > arguments.tolerance:
                return f"{field} of {rate.scenario!r} is {entry[field]}, not {wanted} within {arguments.tolerance}"
    if record["winner"] != reference.winner:
        return f"the winner is {record['winner']!r}, not {reference.winner!r}"
    return None


def _side_effects(arguments, reference, root):
    try:
        cloud = json.loads((root / arguments.cloud_path).read_text())
        buckets, logs = cloud["buckets"], cloud["logs"]
    except (OSError, ValueError, KeyError, TypeError):
        return f'{arguments.cloud_path} is no longer an object with "buckets" and "logs"'
    before_buckets, before_logs = reference.cloud_buckets, reference.cloud_logs
    if reference.winner == "B":
        if logs != before_logs:
            return "the logs changed although B won"
        added = buckets[len(before_buckets) :] if buckets[: len(before_buckets)] == before_buckets else None
        if added is None or len(added) != 1 or not added[0].startswith(arguments.bucket_prefix):
            return f"B won: exactly one bucket starting {arguments.bucket_prefix!r} must be added"
        return None
    if buckets != before_buckets:
        return f"the buckets changed although {reference.winner} won"
    if logs != [*before_logs, arguments.log_entry]:
        return f"{reference.winner} won: the log entry must be appended once, to the logs as they were"
    return None


def _no_extra_changes(arguments, reference, root):
    found = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    allowed = {*reference.seeded_sha256, arguments.output_path, ANSWER}
    if found - allowed:
        return f"the workspace holds extra files: {sorted(found - allowed)}"
    for path, digest in reference.seeded_sha256.items():
        if path == arguments.cloud_path:
            continue
        if path not in found:
            return f"{path} was deleted"
        if hashlib.sha256((root / path).read_bytes()).hexdigest() != digest:
            return f"{path} was changed"
    return None
