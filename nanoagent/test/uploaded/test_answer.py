"""`read_answer`: the coding policy's answer.json, read with the plugin benchmark's rules."""

from __future__ import annotations

from pathlib import Path

import pytest

from nanoagent.uploaded.answer import read_answer


def write(folder: Path, content: str | bytes) -> Path:
    path = folder / "answer.json"
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return folder


def test_an_object_is_the_answer(tmp_path: Path) -> None:
    assert read_answer(write(tmp_path, '{"sum": 3}')) == ({"sum": 3}, None, None)


def test_a_lone_refused_key_is_a_refusal(tmp_path: Path) -> None:
    assert read_answer(write(tmp_path, '{"refused": "no data"}')) == (None, "no data", None)


def test_refused_beside_other_keys_is_an_answer(tmp_path: Path) -> None:
    assert read_answer(write(tmp_path, '{"refused": "x", "sum": 1}'))[0] == {"refused": "x", "sum": 1}


@pytest.mark.parametrize(
    ("content", "failure"),
    [
        ('{"refused": ""}', "nonempty refusal reason"),
        ('{"refused": 3}', "nonempty refusal reason"),
        ("[1]", "not a JSON object"),
        ("nope", "not UTF-8 JSON"),
        (b"\xff\xfe", "not UTF-8 JSON"),
    ],
)
def test_unusable_content_is_a_failure(tmp_path: Path, content: str | bytes, failure: str) -> None:
    answer, refusal, message = read_answer(write(tmp_path, content))
    assert answer is None and refusal is None and message is not None and failure in message


def test_a_missing_file_is_a_failure(tmp_path: Path) -> None:
    assert read_answer(tmp_path) == (None, None, "wrote no answer.json")


def test_a_link_is_not_followed(tmp_path: Path) -> None:
    (tmp_path / "real.json").write_text('{"sum": 1}')
    (tmp_path / "answer.json").symlink_to(tmp_path / "real.json")
    answer, refusal, message = read_answer(tmp_path)
    assert answer is None and refusal is None and message is not None and message.startswith("cannot open answer.json")


def test_a_directory_is_not_an_answer(tmp_path: Path) -> None:
    (tmp_path / "answer.json").mkdir()
    answer, refusal, message = read_answer(tmp_path)
    assert answer is None and refusal is None and message is not None
