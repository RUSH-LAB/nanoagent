from __future__ import annotations

import json
from pathlib import Path

import pytest
from fakes import AFTER, FEN, WIN_PROB

import verifier

ARGUMENTS = {"fen": FEN}
REFERENCE = {
    "ok": True,
    "fen": FEN,
    "nodes": 200_000,
    "best": "c3d5",
    "moves": [{"move": move, "position": AFTER[move], "win_prob": WIN_PROB[move]} for move in sorted(AFTER)],
}


def workspace(tmp_path: Path, moves: list[str], *, fen: str = FEN, positions: list[str] | None = None) -> str:
    record = {"fen": fen, "moves": moves, "positions": [AFTER[move] for move in moves] if positions is None else positions}
    (tmp_path / "board.json").write_text(json.dumps(record))
    return str(tmp_path)


def test_approves_the_best_move_at_a_full_score(tmp_path: Path) -> None:
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, workspace(tmp_path, ["c3d5"]))
    assert verdict["valid"] is True and verdict["score"] == 1.0
    assert verdict["details"]["move"] == "c3d5" and verdict["details"]["loss"] == 0.0


def test_approves_a_weak_move_at_the_win_probability_it_gave_away(tmp_path: Path) -> None:
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, workspace(tmp_path, ["a2a3"]))
    assert verdict["valid"] is True
    assert verdict["score"] == pytest.approx(1.0 - (0.92 - 0.49))
    assert verdict["details"]["best"] == "c3d5"


def test_approves_the_agents_move_when_the_engine_answered_it(tmp_path: Path) -> None:
    # The agent's move is the first; what follows is the opponent's and is not scored.
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, workspace(tmp_path, ["c3d5", "f1e1"]))
    assert verdict["valid"] is True and verdict["details"]["move"] == "c3d5"


def test_refuses_a_task_with_no_board_record(tmp_path: Path) -> None:
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, str(tmp_path))
    assert verdict["valid"] is False and verdict["score"] == 0.0
    assert "no board.json" in verdict["message"]


@pytest.mark.parametrize(
    ("moves", "message"),
    [
        ([], "played no move"),
        (["c3d5", "f1e1", "a2a3"], "played 2 moves"),
    ],
)
def test_refuses_no_move_and_a_second_move_of_the_agents_own(tmp_path: Path, moves: list[str], message: str) -> None:
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, workspace(tmp_path, moves))
    assert verdict["valid"] is False and verdict["score"] == 0.0 and message in verdict["message"]


def test_refuses_a_move_the_position_does_not_have(tmp_path: Path) -> None:
    moved = {"fen": FEN, "moves": ["e2e4"], "positions": [AFTER["c3d5"]]}
    (tmp_path / "board.json").write_text(json.dumps(moved))
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, str(tmp_path))
    assert verdict["valid"] is False and verdict["score"] == 0.0
    assert "not a legal move" in verdict["message"] and verdict["details"]["legal"] == sorted(AFTER)


def test_refuses_a_record_whose_position_is_not_the_one_the_move_leads_to(tmp_path: Path) -> None:
    where = workspace(tmp_path, ["c3d5"], positions=[AFTER["a2a3"]])
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, where)
    assert verdict["valid"] is False and "is not the one c3d5 leads to" in verdict["message"]


def test_refuses_a_game_played_from_another_position(tmp_path: Path) -> None:
    where = workspace(tmp_path, ["c3d5"], fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, where)
    assert verdict["valid"] is False and "another position" in verdict["message"]


def test_refuses_a_malformed_record(tmp_path: Path) -> None:
    (tmp_path / "board.json").write_text(json.dumps({"fen": FEN, "moves": ["c3d5"], "positions": []}))
    verdict = verifier.verify_task("play-move", ARGUMENTS, REFERENCE, str(tmp_path))
    assert verdict["valid"] is False and "one position per move" in verdict["message"]


def test_refuses_an_unknown_task_and_an_unknown_tool() -> None:
    assert verifier.verify_task("other", ARGUMENTS, REFERENCE, ".")["valid"] is False
    assert verifier.verify_input("other", {})["valid"] is False


def test_checks_each_tools_input(tmp_path: Path) -> None:
    assert verifier.verify_input("pin_moves", ARGUMENTS)["valid"] is True
    assert verifier.verify_input("pin_moves", {"fen": "not a position"})["valid"] is False
    assert verifier.verify_input("screenshot", {})["valid"] is True
    assert verifier.verify_input("screenshot", {"fen": FEN})["valid"] is False
    assert verifier.verify_input("drag", {"from_xy": [1, 2], "to_xy": [3, 4]})["valid"] is True
    assert verifier.verify_input("drag", {"from_xy": [1, 2], "to_xy": [1, 2]})["valid"] is False
    assert verifier.verify_input("drag", {"from_xy": [1, -2], "to_xy": [3, 4]})["valid"] is False
    assert verifier.verify_input("click", {"xy": [1, 2]})["valid"] is True
    assert verifier.verify_input("click", {"xy": [1]})["valid"] is False


def test_checks_the_pinned_moves(tmp_path: Path) -> None:
    good = verifier.verify_output("pin_moves", ARGUMENTS, REFERENCE, str(tmp_path))
    assert good["valid"] is True and good["details"]["best"] == "c3d5"
    for broken, problem in [
        ({"best": "f1e1"}, "highest win probability"),
        ({"best": "h2h4"}, "not one of the pinned moves"),
        ({"moves": []}, "no pinned move"),
        ({"fen": AFTER["c3d5"]}, "another position"),
        ({"moves": [{"move": "c3d5", "position": FEN, "win_prob": 0.9}]}, "same side to move"),
    ]:
        verdict = verifier.verify_output("pin_moves", ARGUMENTS, REFERENCE | broken, str(tmp_path))
        assert verdict["valid"] is False and problem in verdict["message"]


def test_checks_the_board_tools_output(tmp_path: Path) -> None:
    shot = {"ok": True, "width": 676, "height": 676, "images": [{"media_type": "image/png", "data": "QQ=="}]}
    where = workspace(tmp_path, [])
    assert verifier.verify_output("screenshot", {}, shot, where)["valid"] is True
    assert verifier.verify_output("open_board", ARGUMENTS, shot, where)["valid"] is True
    assert verifier.verify_output("open_board", {"fen": AFTER["c3d5"]}, shot, where)["valid"] is False
    assert verifier.verify_output("screenshot", {}, shot | {"images": []}, where)["valid"] is False
    assert verifier.verify_output("screenshot", {}, shot | {"width": 0}, where)["valid"] is False
    assert verifier.verify_output("drag", {}, {"ok": True}, where)["valid"] is True
    assert verifier.verify_output("drag", {}, {"ok": True}, str(tmp_path / "empty"))["valid"] is False
    # A structured failure is the plugin saying what went wrong, not a verifier failure.
    assert verifier.verify_output("click", {}, {"ok": False, "error": "no board"}, where) == {
        "valid": True,
        "score": 0.0,
        "message": "plugin returned a structured failure",
        "details": {},
    }
