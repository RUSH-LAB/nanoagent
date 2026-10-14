from __future__ import annotations

import pytest
from fakes import AFTER, FEN, WIN_PROB, FakeEngine

from plugin.pin import NODES, pin_moves
from plugin.uci import parse_fen, parse_perft, parse_score


def test_pins_every_legal_move_with_its_position_and_win_probability() -> None:
    engine = FakeEngine()
    pinned = pin_moves(FEN, [], engine=engine)
    assert pinned.position == FEN and pinned.nodes == NODES and pinned.best == "c3d5"
    assert [entry.move for entry in pinned.moves] == sorted(AFTER)
    assert {entry.move: round(entry.win_prob, 2) for entry in pinned.moves} == WIN_PROB
    assert {entry.move: entry.position for entry in pinned.moves} == AFTER
    # One search per legal move, each at the same node count: the same position pins the same way.
    assert engine.searched == [(move, NODES) for move in sorted(AFTER)]


def test_refuses_a_position_stockfish_spells_differently() -> None:
    engine = FakeEngine()
    engine.fen = lambda fen, moves=(): "8/8/8/8/8/8/8/8 w - - 0 1"
    with pytest.raises(ValueError, match="reads the position as"):
        pin_moves(FEN, [], engine=engine)


def test_pins_the_position_the_games_moves_lead_to() -> None:
    engine = FakeEngine()
    assert pin_moves(FEN, ["f1e1"], engine=engine).position == AFTER["f1e1"]
    with pytest.raises(ValueError, match="'e2e4' is not a legal move"):
        pin_moves(FEN, ["e2e4"], engine=engine)


def test_refuses_a_position_with_no_legal_move() -> None:
    engine = FakeEngine()
    engine.legal = lambda fen: []
    with pytest.raises(ValueError, match="no legal move"):
        pin_moves(FEN, [], engine=engine)


def test_reads_stockfishs_position_moves_and_score() -> None:
    assert parse_fen(["Checkers:", f"Fen: {FEN}"]) == FEN
    assert parse_perft(["a2a3: 1", "b1c3: 1", "a2a4: 2", "Nodes searched: 3"]) == ["a2a3", "b1c3"]
    assert parse_score(["info depth 2 score cp 31 nodes 9", "bestmove e2e4"]) == ("cp", 31)
    assert parse_score(["info score cp 31", "info score mate -3", "bestmove e2e4"]) == ("mate", -3)
    # A bound is the search saying it does not know the score yet, so the last exact one stands.
    assert parse_score(["info score cp 31", "info score cp 80 upperbound", "bestmove e2e4"]) == ("cp", 31)


def test_says_so_when_stockfish_answers_with_neither() -> None:
    with pytest.raises(ValueError, match="no Fen"):
        parse_fen(["Checkers:"])
    with pytest.raises(ValueError, match="no score"):
        parse_score(["bestmove e2e4"])
