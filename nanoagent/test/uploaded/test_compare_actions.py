from dataclasses import replace

import pytest

from nanoagent.uploaded.compare import (
    Action,
    Attempt,
    FieldCoverage,
    RunConditions,
    canonical_json,
    command_input,
    compare,
    json_diff,
)
from nanoagent.uploaded.timing import Unknown

ROOT: tuple[str, ...] = ()


def act(action_id: str, kind: str, target: str, input: object, **kw) -> Action:
    return Action(action_id, kind, target, input, **kw)  # type: ignore[arg-type]


def read(action_id: str = "r", path: str = "config.yaml") -> Action:
    return act(action_id, "tool_call", "read_file", {"path": path})


def cmd(action_id: str, *argv: str, **kw) -> Action:
    return act(action_id, "command", argv[0], command_input(list(argv), "/work"), **kw)


def attempt(*actions: Action, covered: bool = True, conditions: RunConditions = RunConditions(), estimated_ns: int | None = None) -> Attempt:
    return Attempt(conditions, tuple(actions), frozenset({ROOT}) if covered else frozenset(), estimated_ns)


def test_canonical_json_sorts_keys_and_keeps_array_order():
    assert canonical_json({"b": [2, 1], "a": {"d": 1, "c": 2}}) == '{"a":{"c":2,"d":1},"b":[2,1]}'


def test_plan_example_extra_tool_call_and_changed_command():
    a = attempt(read("r1"), cmd("c1", "go", "test", "./..."))
    b = attempt(
        read("r2"),
        act("t2", "tool_call", "validate_config", {"path": "config.yaml"}),
        cmd("c2", "go", "test", "./pkg/config"),
    )
    result = compare(a, b)
    assert [row.status for row in result.rows] == ["same", "changed", "only_b"]
    changed = result.rows[1]
    assert [(d.path, d.a, d.b) for d in changed.input_diff] == [("$.argv[2]", "./...", "./pkg/config")]
    assert result.rows[2].b[0].target == "validate_config"
    assert result.first_difference == 1
    assert [row.status for row in result.differences_only()] == ["changed", "only_b"]


def test_one_changed_input_has_field_level_diff():
    result = compare(attempt(read(path="a.yaml")), attempt(read(path="b.yaml")))
    (row,) = result.rows
    assert row.status == "changed"
    assert [(d.path, d.a, d.b) for d in row.input_diff] == [("$.path", "a.yaml", "b.yaml")]


def test_identical_attempts_have_no_difference():
    result = compare(attempt(read(), cmd("c", "ls")), attempt(read("x"), cmd("y", "ls")))
    assert result.first_difference is None
    assert result.differences_only() == ()


def test_additional_call_is_only_in_b():
    result = compare(attempt(read("r1")), attempt(read("r2"), cmd("c", "ls")))
    assert [row.status for row in result.rows] == ["same", "only_b"]


def test_retry_stays_a_distinct_action():
    first = replace(read("r1"), status="error")
    result = compare(attempt(read("r0")), attempt(first, read("r2")))
    assert [row.status for row in result.rows] == ["same", "only_b"]
    assert result.rows[0].status_diff == (None, "error")


def test_repeated_identical_calls_preserve_counts():
    result = compare(attempt(read("1"), read("2"), read("3")), attempt(read("4"), read("5")))
    assert [row.status for row in result.rows] == ["same", "same", "only_a"]


def overlapping(action_id: str, target: str, start: int, end: int) -> Action:
    return act(action_id, "tool_call", target, {}, start_ns=start, end_ns=end)


def test_parallel_calls_finishing_in_a_different_order_are_not_a_difference():
    a = attempt(overlapping("x", "slow", 0, 9), overlapping("y", "fast", 1, 3), act("z", "tool_call", "after", {}, start_ns=10, end_ns=11))
    b = attempt(overlapping("y2", "fast", 1, 2), overlapping("x2", "slow", 0, 8), act("z2", "tool_call", "after", {}, start_ns=10, end_ns=11))
    result = compare(a, b)
    assert all(row.status == "same" for row in result.rows)
    assert not any(row.sequence_changed or row.concurrency_changed for row in result.rows)
    assert result.first_difference is None


def test_explicit_group_makes_siblings_parallel_without_timing():
    a = attempt(act("x", "tool_call", "p", {}, group="g"), act("y", "tool_call", "q", {}, group="g"))
    b = attempt(act("y2", "tool_call", "q", {}, group="g"), act("x2", "tool_call", "p", {}, group="g"))
    assert compare(a, b).first_difference is None


def test_causal_link_stops_overlap_from_making_a_group():
    x = overlapping("x", "p", 0, 5)
    y = replace(overlapping("y", "q", 1, 6), after=("x",))
    a = attempt(x, y)
    swapped = attempt(replace(y, action_id="y2", after=()), replace(x, action_id="x2"))
    result = compare(a, swapped)
    assert [row.concurrency_changed for row in result.rows] == [True, True]


def sequential(action_id: str, target: str, start: int) -> Action:
    return act(action_id, "tool_call", target, {}, start_ns=start, end_ns=start + 1)


def test_reordered_sequential_actions_are_a_sequence_change():
    a = attempt(sequential("x", "p", 0), sequential("y", "q", 2))
    b = attempt(sequential("y2", "q", 0), sequential("x2", "p", 2))
    result = compare(a, b)
    assert all(row.status == "same" for row in result.rows)
    assert [row.sequence_changed for row in result.rows] == [True, True]
    assert result.first_difference is not None


def test_unresolved_order_is_ambiguous_not_a_sequence_change():
    a = attempt(act("x", "tool_call", "p", {}), act("y", "tool_call", "q", {}))
    b = attempt(act("y2", "tool_call", "q", {}), act("x2", "tool_call", "p", {}))
    result = compare(a, b)
    assert all(row.status == "same" for row in result.rows)
    assert all(isinstance(row.sequence_changed, Unknown) for row in result.rows)
    assert result.first_difference == 0


def test_linked_order_resolves_the_sequence_change_without_a_clock():
    a = attempt(act("x", "tool_call", "p", {}), act("y", "tool_call", "q", {}, after=("x",)))
    b = attempt(act("y2", "tool_call", "q", {}), act("x2", "tool_call", "p", {}, after=("y2",)))
    assert [row.sequence_changed for row in compare(a, b).rows] == [True, True]


def test_first_difference_is_earliest_by_start_time_across_scopes():
    sub: tuple[str, ...] = ("sub",)
    a = Attempt(
        RunConditions(),
        (
            act("r", "tool_call", "read_file", {"path": "a"}, start_ns=50, end_ns=60),
            act("s", "tool_call", "read_file", {"path": "a"}, scope=sub, start_ns=10, end_ns=20),
        ),
        frozenset({ROOT, sub}),
    )
    b = Attempt(
        RunConditions(),
        (
            act("r2", "tool_call", "read_file", {"path": "b"}, start_ns=50, end_ns=60),
            act("s2", "tool_call", "read_file", {"path": "b"}, scope=sub, start_ns=10, end_ns=20),
        ),
        frozenset({ROOT, sub}),
    )
    result = compare(a, b)
    assert [row.a[0].scope for row in result.rows] == [ROOT, sub]
    assert result.first_difference == 1


def test_changed_parallel_group_reports_the_group_start():
    a = attempt(overlapping("x", "p", 0, 5), overlapping("y", "q", 1, 6))
    b = attempt(overlapping("x2", "p", 0, 5), replace(overlapping("y2", "q", 1, 6), input={"k": 1}))
    result = compare(a, b)
    assert result.first_difference == 0
    assert result.rows[1].status == "changed"


def test_non_unique_pairing_is_ambiguous():
    a = attempt(cmd("c1", "go", "test", "./a"), cmd("c2", "go", "test", "./b"))
    b = attempt(cmd("c3", "go", "test", "./c"))
    (row,) = compare(a, b).rows
    assert row.status == "ambiguous"
    assert len(row.a) == 2 and len(row.b) == 1


def test_missing_scope_coverage_makes_absence_unknown():
    result = compare(attempt(read("r"), cmd("c", "ls")), attempt(read("r2"), covered=False))
    assert [row.status for row in result.rows] == ["same", "unknown"]
    assert "no action coverage" in result.rows[1].reason


def test_redacted_input_is_unknown_not_a_difference():
    redacted = replace(read("r2"), coverage=FieldCoverage(input="redacted"))
    (row,) = compare(attempt(read("r1")), attempt(redacted)).rows
    assert row.status == "unknown"


def test_redacted_output_is_unknown_in_an_otherwise_equal_row():
    a = replace(read("r1"), output="x")
    b = replace(read("r2"), output="x", coverage=FieldCoverage(output="missing"))
    (row,) = compare(attempt(a), attempt(b)).rows
    assert isinstance(row.output_diff, Unknown)
    assert not row.is_equal


def test_output_status_and_deltas_are_separate_fields():
    a = replace(read("r1"), output="old", status="ok", duration_ns=10, tokens=5, cost=None)
    b = replace(read("r2"), output="new", status="error", duration_ns=30, tokens=8, cost=None, coverage=FieldCoverage(cost="missing"))
    (row,) = compare(attempt(a), attempt(b)).rows
    assert [(d.path, d.a, d.b) for d in row.output_diff] == [("$", "old", "new")]
    assert row.status_diff == ("ok", "error")
    assert row.duration_delta_ns == 20
    assert row.token_delta == 3
    assert isinstance(row.cost_delta, Unknown)


def test_unrecorded_cost_and_tokens_are_unknown_not_differences():
    missing = FieldCoverage(tokens="missing", cost="missing")
    a = [replace(read("r1"), tokens=None, cost=None, coverage=missing), replace(read("r2", "other.yaml"), tokens=None, cost=None, coverage=missing)]
    b = [replace(read("s1"), tokens=None, cost=None, coverage=missing), replace(read("s2", "changed.yaml"), tokens=None, cost=None, coverage=missing)]
    result = compare(attempt(*a), attempt(*b))
    first, second = result.rows
    assert isinstance(first.token_delta, Unknown) and isinstance(first.cost_delta, Unknown)
    assert first.is_equal  # nothing recorded differs: unknown cost and tokens do not make the row a difference
    assert not second.is_equal  # a recorded input change still does
    assert result.first_difference == 1 and [row.status for row in result.differences_only()] == ["changed"]
    # A recorded change in either count is still a difference.
    known = compare(attempt(replace(read("r1"), tokens=5, cost=None)), attempt(replace(read("s1"), tokens=6, cost=None))).rows[0]
    assert known.token_delta == 1 and not known.is_equal


def test_conditions_are_flagged_and_estimates_need_the_same_method():
    ca = RunConditions(model="m1", timing_method="tokens", reference_tokens_per_second=100.0)
    cb = RunConditions(model="m2", timing_method="tokens", reference_tokens_per_second=100.0)
    result = compare(attempt(conditions=ca, estimated_ns=5), attempt(conditions=cb, estimated_ns=9))
    states = {c.name: c.state for c in result.conditions}
    assert states["model"] == "different"
    assert states["timing_method"] == "same"
    assert states["provider"] == "unknown"
    assert result.estimate_delta_ns == 4
    other_rate = replace(cb, reference_tokens_per_second=50.0)
    assert isinstance(compare(attempt(conditions=ca, estimated_ns=5), attempt(conditions=other_rate, estimated_ns=9)).estimate_delta_ns, Unknown)
    assert isinstance(compare(attempt(), attempt()).estimate_delta_ns, Unknown)


def test_json_diff_handles_arrays_and_absent_keys():
    diffs = json_diff({"a": [1, 2], "b": 1}, {"a": [1, 3, 4], "c": 1})
    assert [(d.path, d.a_present, d.b_present) for d in diffs] == [
        ("$.a[1]", True, True),
        ("$.a[2]", False, True),
        ("$.b", True, False),
        ("$.c", False, True),
    ]
    assert json_diff(1, 1.0)[0].path == "$"


def test_unrecorded_causal_link_is_rejected():
    with pytest.raises(ValueError):
        compare(attempt(act("x", "tool_call", "p", {}, after=("ghost",))), attempt())
