"""BibTeX text parsed into the registered schema."""

from __future__ import annotations

import re

import bibtexparser
from bibtexparser import model
from bibtexparser.exceptions import BlockAbortedException

from contract import Entry, ParseInput, ParseOutput, ReadInput, ReadOutput
from plugin.schema import to_record

# The citation key of an entry the parser gave up on: `@article{key,`.
FAILED_KEY = re.compile(r"^\s*@\w+\s*\{\s*([^,\s]+)\s*,")


def parse_text(text: str, name: str) -> list[Entry]:
    """Every entry of BibTeX ``text`` (``name`` in errors), in order: its key, and its schema record or
    why it has none."""
    library = bibtexparser.parse_string(text)
    entries = []
    for block in library.blocks:
        if isinstance(block, model.ParsingFailedBlock):
            key = FAILED_KEY.match(block.raw)
            if key is None:
                raise ValueError(f"{name} line {block.start_line + 1} is not an entry with a key")
            reason = block.error.abort_reason if isinstance(block.error, BlockAbortedException) else str(block.error)
            entries.append(Entry(key=key.group(1), record=None, error=f"unparseable: {reason}"))
        elif isinstance(block, model.Entry):
            fields = [(field.key, field.value) for field in block.fields]
            try:
                entries.append(Entry(key=block.key, record=to_record(block.entry_type, fields), error=None))
            except ValueError as error:
                entries.append(Entry(key=block.key, record=None, error=f"not in the schema: {error}"))
    keys = [entry.key for entry in entries]
    twice = sorted({key for key in keys if keys.count(key) > 1})
    if twice:
        raise ValueError(f"{name} has these keys twice: {', '.join(twice)}")
    return entries


def parse_bibtex(given: ParseInput) -> ParseOutput:
    """Both texts' entries in the registered schema: the check-bibtex task's ground truth. Every
    reference entry must parse; a raw entry that does not is kept, with no record."""
    references = parse_text(given.reference, "the reference BibTeX")
    broken = [entry.key for entry in references if entry.record is None]
    if broken:
        raise ValueError(f"reference entries do not parse into the schema: {', '.join(broken)}")
    return ParseOutput(reference=references, raw=parse_text(given.raw, "the raw BibTeX"))


def read_bibtex(given: ReadInput) -> ReadOutput:
    """One text's entries in the registered schema."""
    return ReadOutput(entries=parse_text(given.bibtex, "the BibTeX"))
