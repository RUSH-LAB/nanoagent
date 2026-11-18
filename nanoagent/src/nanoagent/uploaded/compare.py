"""Deterministic comparison of two attempts' recorded actions.

Conditions and unknown fields come first, then rows aligned by exact action key (kind, target, canonical
input) inside each agent scope. Nothing here consults a model or the clock: a pairing that the recorded
links and trusted intervals cannot resolve is reported as ambiguous, and evidence a side did not record is
reported as Unknown rather than as an absence or a difference.
"""

import json
from dataclasses import dataclass, fields
from decimal import Decimal
from typing import Literal

from nanoagent.uploaded.timing import Unknown

JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
Scope = tuple[str, ...]
Evidence = Literal["complete", "redacted", "missing"]
RowStatus = Literal["same", "changed", "only_a", "only_b", "ambiguous", "unknown"]
Key = tuple[str, str, str]


def canonical_json(value: JsonValue) -> str:
    """Sorted object keys, preserved array order, no insignificant whitespace."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


@dataclass(frozen=True)
class FieldCoverage:
    input: Evidence = "complete"
    output: Evidence = "complete"
    status: Evidence = "complete"
    timing: Evidence = "complete"
    tokens: Evidence = "complete"
    cost: Evidence = "complete"


@dataclass(frozen=True)
class Action:
    action_id: str
    kind: str
    target: str
    input: JsonValue
    scope: Scope = ()
    start_ns: int | None = None
    end_ns: int | None = None
    after: tuple[str, ...] = ()
    group: str | None = None
    status: str | None = None
    output: JsonValue = None
    duration_ns: int | None = None
    tokens: int | None = None
    cost: Decimal | None = None
    coverage: FieldCoverage = FieldCoverage()


@dataclass(frozen=True)
class RunConditions:
    harness_revision: str | None = None
    prompt_digest: str | None = None
    endpoint_profile: str | None = None
    model: str | None = None
    provider: str | None = None
    dialect: str | None = None
    policy: str | None = None
    internet_access: bool | None = None
    egress_hosts: tuple[str, ...] | None = None
    limits: tuple[tuple[str, int | float | bool], ...] | None = None
    timing_method: str | None = None
    reference_tokens_per_second: float | None = None
    coverage: str | None = None


@dataclass(frozen=True)
class Attempt:
    """`actions` are in recorded order. `covered_scopes` are the scopes whose action record is complete."""

    conditions: RunConditions
    actions: tuple[Action, ...]
    covered_scopes: frozenset[Scope]
    estimated_ns: int | None = None


@dataclass(frozen=True)
class ConditionDiff:
    name: str
    a: object
    b: object
    state: Literal["same", "different", "unknown"]


@dataclass(frozen=True)
class FieldDiff:
    path: str
    a: JsonValue
    b: JsonValue
    a_present: bool = True
    b_present: bool = True


Delta = int | Decimal | Unknown | None


@dataclass(frozen=True)
class Row:
    """`a` and `b` hold one action for a pair or extra, and every candidate for an ambiguous row."""

    status: RowStatus
    a: tuple[Action, ...]
    b: tuple[Action, ...]
    reason: str | None = None
    input_diff: tuple[FieldDiff, ...] | Unknown | None = None
    output_diff: tuple[FieldDiff, ...] | Unknown | None = None
    status_diff: tuple[str | None, str | None] | Unknown | None = None
    sequence_changed: bool | Unknown = False
    concurrency_changed: bool = False
    duration_delta_ns: Delta = None
    token_delta: Delta = None
    cost_delta: Delta = None
    group: str | None = None

    @property
    def is_equal(self) -> bool:
        if self.status != "same":
            return False
        if any(isinstance(d, Unknown) or d for d in (self.input_diff, self.output_diff, self.status_diff)):
            return False
        if isinstance(self.sequence_changed, Unknown) or self.sequence_changed or self.concurrency_changed:
            return False
        # An unrecorded token or cost count is Unknown, never a difference: only a recorded change in either one differs.
        return not any(not isinstance(d, Unknown) and d for d in (self.token_delta, self.cost_delta))


@dataclass(frozen=True)
class Comparison:
    conditions: tuple[ConditionDiff, ...]
    estimate_delta_ns: int | Unknown
    rows: tuple[Row, ...]
    first_difference: int | None = None

    def differences_only(self) -> tuple[Row, ...]:
        return tuple(row for row in self.rows if not row.is_equal)


def json_diff(a: JsonValue, b: JsonValue, path: str = "$") -> tuple[FieldDiff, ...]:
    if isinstance(a, dict) and isinstance(b, dict):
        return tuple(d for key in sorted(a.keys() | b.keys()) for d in _child_diff(a, b, key, _key_path(path, key)))
    if isinstance(a, list) and isinstance(b, list):
        return tuple(d for i in range(max(len(a), len(b))) for d in _child_diff(dict(enumerate(a)), dict(enumerate(b)), i, f"{path}[{i}]"))
    return () if canonical_json(a) == canonical_json(b) else (FieldDiff(path, a, b),)


def _key_path(path: str, key: str) -> str:
    return f"{path}.{key}" if key.isidentifier() else f"{path}[{json.dumps(key)}]"


def _child_diff(a: dict, b: dict, key: object, path: str) -> tuple[FieldDiff, ...]:
    if key in a and key in b:
        return json_diff(a[key], b[key], path)
    if key in a:
        return (FieldDiff(path, a[key], None, b_present=False),)
    return (FieldDiff(path, None, b[key], a_present=False),)


def _condition_diffs(a: RunConditions, b: RunConditions) -> tuple[ConditionDiff, ...]:
    def state(x: object, y: object) -> Literal["same", "different", "unknown"]:
        if x is None or y is None:
            return "unknown"
        return "same" if x == y else "different"

    return tuple(
        ConditionDiff(f.name, getattr(a, f.name), getattr(b, f.name), state(getattr(a, f.name), getattr(b, f.name))) for f in fields(RunConditions)
    )


def _estimate_delta(a: Attempt, b: Attempt) -> int | Unknown:
    ca, cb = a.conditions, b.conditions
    if None in (ca.timing_method, cb.timing_method, ca.reference_tokens_per_second, cb.reference_tokens_per_second):
        return Unknown("timing method or reference rate is unknown")
    if (ca.timing_method, ca.reference_tokens_per_second) != (cb.timing_method, cb.reference_tokens_per_second):
        return Unknown("estimates use different timing methods or reference rates")
    if a.estimated_ns is None or b.estimated_ns is None:
        return Unknown("an estimate is unknown")
    return b.estimated_ns - a.estimated_ns


@dataclass(frozen=True)
class _Placed:
    action: Action
    pos: int
    unit: int
    parallel: bool

    @property
    def key(self) -> Key | None:
        a = self.action
        return (a.kind, a.target, canonical_json(a.input)) if a.coverage.input == "complete" else None


def _reachable(actions: tuple[Action, ...]) -> dict[str, set[str]]:
    ids = {a.action_id for a in actions}
    if len(ids) != len(actions):
        raise ValueError("action ids are not unique")
    links = {a.action_id: a.after for a in actions}
    for action_id, after in links.items():
        for pred in after:
            if pred not in ids:
                raise ValueError(f"action {action_id} follows unrecorded action {pred}")
    reach: dict[str, set[str]] = {}

    def ancestors(action_id: str) -> set[str]:
        if action_id not in reach:
            reach[action_id] = set()
            for pred in links[action_id]:
                reach[action_id] |= {pred} | ancestors(pred)
        return reach[action_id]

    for action_id in links:
        ancestors(action_id)
    return reach


def _timed(x: Action) -> bool:
    return x.coverage.timing == "complete" and x.start_ns is not None and x.end_ns is not None


def _trusted_overlap(x: Action, y: Action) -> bool:
    return _timed(x) and _timed(y) and x.start_ns < y.end_ns and y.start_ns < x.end_ns  # type: ignore[operator]


def _linked(x: Action, y: Action, reach: dict[str, set[str]]) -> bool:
    return y.action_id in reach[x.action_id] or x.action_id in reach[y.action_id]


def _resolved(x: Action, y: Action, reach: dict[str, set[str]]) -> bool:
    """Whether recorded links or a trusted clock establish which of two actions came first."""
    if _linked(x, y, reach):
        return True
    return _timed(x) and _timed(y) and not _trusted_overlap(x, y)


def _arrange(attempt: Attempt, reach: dict[str, set[str]]) -> dict[Scope, list[_Placed]]:
    """Per scope: actions with parallel siblings collapsed into units and ordered independent of completion."""
    by_scope: dict[Scope, list[Action]] = {}
    for action in attempt.actions:
        by_scope.setdefault(action.scope, []).append(action)
    placed: dict[Scope, list[_Placed]] = {}
    for scope, actions in by_scope.items():
        parent = list(range(len(actions)))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i, x in enumerate(actions):
            for j in range(i + 1, len(actions)):
                y = actions[j]
                grouped = x.group is not None and x.group == y.group
                if grouped or (_trusted_overlap(x, y) and not _linked(x, y, reach)):
                    parent[find(j)] = find(i)
        units: dict[int, list[int]] = {}
        for i in range(len(actions)):
            units.setdefault(find(i), []).append(i)
        ordered_units = sorted(units.values(), key=min)
        out: list[_Placed] = []
        for unit_number, members in enumerate(ordered_units):
            def sort_key(i: int) -> tuple[str, str, str, int]:
                a = actions[i]
                canon = canonical_json(a.input) if a.coverage.input == "complete" else ""
                return (a.kind, a.target, canon, i)

            for i in sorted(members, key=sort_key):
                out.append(_Placed(actions[i], len(out), unit_number, len(members) > 1))
        placed[scope] = out
    return placed


def _lcs_anchors(a: list[_Placed], b: list[_Placed]) -> list[tuple[int, int]]:
    ka, kb = [p.key for p in a], [p.key for p in b]
    dp = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) - 1, -1, -1):
        for j in range(len(b) - 1, -1, -1):
            match = 1 + dp[i + 1][j + 1] if ka[i] is not None and ka[i] == kb[j] else 0
            dp[i][j] = max(match, dp[i + 1][j], dp[i][j + 1])
    anchors, i, j = [], 0, 0
    while i < len(a) and j < len(b):
        if ka[i] is not None and ka[i] == kb[j] and dp[i][j] == 1 + dp[i + 1][j + 1]:
            anchors.append((i, j))
            i, j = i + 1, j + 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return anchors


@dataclass(frozen=True)
class _Item:
    status: RowStatus
    a: tuple[_Placed, ...]
    b: tuple[_Placed, ...]
    reason: str | None = None


def _item_order(item: _Item) -> tuple[int, int]:
    return (0, item.a[0].pos) if item.a else (1, item.b[0].pos)


def _resolve_gap(
    a_rest: list[_Placed], b_rest: list[_Placed], scope: Scope, a_covered: bool, b_covered: bool
) -> list[_Item]:
    items: list[_Item] = []
    buckets: dict[tuple[str, str], tuple[list[_Placed], list[_Placed]]] = {}
    for x in a_rest:
        buckets.setdefault((x.action.kind, x.action.target), ([], []))[0].append(x)
    for y in b_rest:
        buckets.setdefault((y.action.kind, y.action.target), ([], []))[1].append(y)
    for (kind, target), (xs, ys) in buckets.items():
        if xs and ys:
            if len(xs) == 1 and len(ys) == 1:
                opaque = xs[0].key is None or ys[0].key is None
                items.append(_Item("unknown" if opaque else "changed", (xs[0],), (ys[0],), f"{kind} {target} input was not recorded on both sides" if opaque else None))
            else:
                items.append(_Item("ambiguous", tuple(xs), tuple(ys), f"{len(xs)} vs {len(ys)} unmatched {kind} {target} actions cannot be paired"))
        for x in xs if not ys else []:
            if x.key is None:
                items.append(_Item("unknown", (x,), (), f"{kind} {target} input was not recorded"))
            elif b_covered:
                items.append(_Item("only_a", (x,), ()))
            else:
                items.append(_Item("unknown", (x,), (), f"B has no action coverage for scope {'/'.join(scope) or 'root'}"))
        for y in ys if not xs else []:
            if y.key is None:
                items.append(_Item("unknown", (), (y,), f"{kind} {target} input was not recorded"))
            elif a_covered:
                items.append(_Item("only_b", (), (y,)))
            else:
                items.append(_Item("unknown", (), (y,), f"A has no action coverage for scope {'/'.join(scope) or 'root'}"))
    return sorted(items, key=_item_order)


def _scope_items(scope: Scope, a: list[_Placed], b: list[_Placed], a_att: Attempt, b_att: Attempt) -> list[_Item]:
    a_covered, b_covered = scope in a_att.covered_scopes, scope in b_att.covered_scopes
    gaps: list[tuple[list[_Placed], list[_Placed]]] = []
    anchors = _lcs_anchors(a, b)
    i0 = j0 = 0
    for i, j in [*anchors, (len(a), len(b))]:
        gaps.append((a[i0:i], b[j0:j]))
        i0, j0 = i + 1, j + 1
    # Exact keys that moved relative to their neighbours still match, wherever they landed.
    b_left = [y for _, b_gap in gaps for y in b_gap]
    moved: dict[int, _Placed] = {}
    for x in (x for a_gap, _ in gaps for x in a_gap):
        partner = next((y for y in b_left if x.key is not None and y.key == x.key), None)
        if partner is not None:
            b_left.remove(partner)
            moved[x.pos] = partner
    moved_b = {y.pos for y in moved.values()}
    items: list[_Item] = []
    for k, (a_gap, b_gap) in enumerate(gaps):
        gap_items = [_Item("same", (x,), (moved[x.pos],)) for x in a_gap if x.pos in moved]
        gap_items += _resolve_gap([x for x in a_gap if x.pos not in moved], [y for y in b_gap if y.pos not in moved_b], scope, a_covered, b_covered)
        items.extend(sorted(gap_items, key=_item_order))
        if k < len(anchors):
            i, j = anchors[k]
            items.append(_Item("same", (a[i],), (b[j],)))
    return items


def _delta(x: int | Decimal | None, y: int | Decimal | None, cov_x: Evidence, cov_y: Evidence, name: str) -> Delta:
    if cov_x != "complete" or cov_y != "complete" or (x is None) != (y is None):
        return Unknown(f"{name} was not recorded on both sides")
    return None if x is None or y is None else y - x


def _diff_or_unknown(a: JsonValue, b: JsonValue, cov_a: Evidence, cov_b: Evidence, name: str) -> tuple[FieldDiff, ...] | Unknown:
    if cov_a != "complete" or cov_b != "complete":
        return Unknown(f"{name} is {cov_a if cov_a != 'complete' else cov_b} on one side")
    return json_diff(a, b)


def _row(item: _Item, sequence_changed: bool | Unknown, scope: Scope) -> Row:
    xs, ys = tuple(p.action for p in item.a), tuple(p.action for p in item.b)
    anchor = (item.a or item.b)[0]
    group = f"{'/'.join(scope)}#{anchor.unit}" if anchor.parallel else None
    if item.status not in ("same", "changed"):
        return Row(item.status, xs, ys, item.reason, group=group)
    x, y = xs[0], ys[0]
    status_diff: tuple[str | None, str | None] | Unknown | None = None
    if x.coverage.status != "complete" or y.coverage.status != "complete":
        status_diff = Unknown("status was not recorded on both sides")
    elif x.status != y.status:
        status_diff = (x.status, y.status)
    return Row(
        item.status,
        xs,
        ys,
        input_diff=json_diff(x.input, y.input),
        output_diff=_diff_or_unknown(x.output, y.output, x.coverage.output, y.coverage.output, "output"),
        status_diff=status_diff,
        sequence_changed=sequence_changed,
        concurrency_changed=item.a[0].parallel != item.b[0].parallel,
        duration_delta_ns=_delta(x.duration_ns, y.duration_ns, x.coverage.timing, y.coverage.timing, "duration"),
        token_delta=_delta(x.tokens, y.tokens, x.coverage.tokens, y.coverage.tokens, "tokens"),
        cost_delta=_delta(x.cost, y.cost, x.coverage.cost, y.coverage.cost, "cost"),
        group=group,
    )


def _sequence_changed(item: _Item, paired: list[_Item], reach_a: dict[str, set[str]], reach_b: dict[str, set[str]]) -> bool | Unknown:
    """Changed only against a partner whose order is established on both sides; Unknown if the record can't say."""
    x, y = item.a[0], item.b[0]
    inverted = [
        o
        for o in paired
        if o is not item
        and x.unit != o.a[0].unit
        and y.unit != o.b[0].unit
        and (x.pos < o.a[0].pos) != (y.pos < o.b[0].pos)
    ]
    if not inverted:
        return False
    if any(_resolved(x.action, o.a[0].action, reach_a) and _resolved(y.action, o.b[0].action, reach_b) for o in inverted):
        return True
    return Unknown(f"order of {x.action.kind} {x.action.target} is not resolved by links or a trusted clock")


def _scope_rows(scope: Scope, items: list[_Item], reach_a: dict[str, set[str]], reach_b: dict[str, set[str]]) -> list[Row]:
    paired = [it for it in items if it.status in ("same", "changed")]
    return [_row(it, _sequence_changed(it, paired, reach_a, reach_b) if it in paired else False, scope) for it in items]


def _start_ns(row: Row) -> int | None:
    starts = [x.start_ns for x in (*row.a, *row.b) if _timed(x)]
    return min(starts) if starts else None  # type: ignore[type-var]


def _first_difference(rows: list[Row]) -> int | None:
    """Earliest differing row by recorded start time, recorded order breaking ties and standing in for unknown starts."""
    differing = [i for i, row in enumerate(rows) if not row.is_equal]
    if not differing:
        return None
    first = min(differing, key=lambda i: (_start_ns(rows[i]) is None, _start_ns(rows[i]) or 0, i))
    group = rows[first].group
    return first if group is None else next(j for j, other in enumerate(rows) if other.group == group)


def compare(a: Attempt, b: Attempt) -> Comparison:
    reach_a, reach_b = _reachable(a.actions), _reachable(b.actions)
    placed_a, placed_b = _arrange(a, reach_a), _arrange(b, reach_b)
    scopes = [*placed_a, *(s for s in placed_b if s not in placed_a)]
    rows: list[Row] = []
    for scope in scopes:
        items = _scope_items(scope, placed_a.get(scope, []), placed_b.get(scope, []), a, b)
        rows.extend(_scope_rows(scope, items, reach_a, reach_b))
    return Comparison(
        conditions=_condition_diffs(a.conditions, b.conditions),
        estimate_delta_ns=_estimate_delta(a, b),
        rows=tuple(rows),
        first_difference=_first_difference(rows),
    )
