from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fakes import AFTER, FEN, FakeBoard
from slimconfig import plain_output

from contract import ClickInput, DragInput, Position, Screenshot, ScreenshotInput
from plugin.play import RECORD, Play


def opened(tmp_path: Path) -> tuple[Play, Screenshot]:
    play = Play(FakeBoard)
    return play, play.open_board(Position(fen=FEN), tmp_path)


def test_opening_the_board_shows_it_and_starts_the_record(tmp_path: Path) -> None:
    play, shot = opened(tmp_path)
    assert plain_output(shot) == {
        "width": 676,
        "height": 676,
        "images": [{"media_type": "image/png", "data": base64.b64encode(b"PNG").decode()}],
    }
    assert json.loads((tmp_path / RECORD).read_text()) == {"fen": FEN, "moves": [], "positions": []}
    play.close()
    assert play.live is None


def test_a_drag_plays_a_move_and_records_the_position_it_led_to(tmp_path: Path) -> None:
    play, _ = opened(tmp_path)
    assert plain_output(play.drag(DragInput(from_xy=[211.0, 465.0], to_xy=[296.0, 296.0]), tmp_path)) == {}
    assert play.live.points == [[[211.0, 465.0], [296.0, 296.0]]]
    assert json.loads((tmp_path / RECORD).read_text()) == {
        "fen": FEN,
        "moves": ["c3d5"],
        "positions": [AFTER["c3d5"]],
    }


def test_a_click_is_one_point_and_rewrites_the_record(tmp_path: Path) -> None:
    play, _ = opened(tmp_path)
    assert plain_output(play.click(ClickInput(xy=[211.0, 465.0]), tmp_path)) == {}
    assert play.live.points == [[[211.0, 465.0]]]
    assert json.loads((tmp_path / RECORD).read_text())["moves"] == []


def test_refuses_to_work_a_board_that_is_not_open_or_to_open_a_second(tmp_path: Path) -> None:
    play = Play(FakeBoard)
    with pytest.raises(ValueError, match="not open"):
        play.screenshot(ScreenshotInput(), tmp_path)
    play.open_board(Position(fen=FEN), tmp_path)
    with pytest.raises(ValueError, match="already open"):
        play.open_board(Position(fen=FEN), tmp_path)
