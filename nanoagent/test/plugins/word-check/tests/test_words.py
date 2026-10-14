from __future__ import annotations

import pytest

from contract import ParseInput, ReadInput, Word
from plugin.words import parse_words, read_words


def test_reads_each_word_with_an_error_when_it_is_not_all_letters() -> None:
    assert read_words(ReadInput(text=" cat  d0g ")).words == [Word(text="cat", error=None), Word(text="d0g", error="'d0g' is not all letters")]


def test_every_reference_word_must_be_all_letters() -> None:
    assert [word.text for word in parse_words(ParseInput(reference="cat", raw="d0g")).raw] == ["d0g"]
    with pytest.raises(ValueError, match="all letters"):
        parse_words(ParseInput(reference="cat d0g", raw="cat"))
