from __future__ import annotations

from contract import ParseInput, ParseOutput, ReadInput, ReadOutput, Word


def read(text: str) -> list[Word]:
    """``text``'s words, split on whitespace; a word that is not all letters has an error."""
    return [Word(text=word, error=None if word.isalpha() else f"{word!r} is not all letters") for word in text.split()]


def read_words(given: ReadInput) -> ReadOutput:
    return ReadOutput(words=read(given.text))


def parse_words(given: ParseInput) -> ParseOutput:
    reference = read(given.reference)
    unreadable = [word.text for word in reference if word.error is not None]
    if unreadable:
        raise ValueError(f"every reference word must be all letters: {unreadable}")
    return ParseOutput(reference=reference, raw=read(given.raw))
