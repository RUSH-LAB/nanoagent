"""BibTeX files parsed into the registered schema, and the agent's verdicts."""

from __future__ import annotations

import json
import re
from pathlib import Path

import bibtexparser
from bibtexparser.exceptions import BlockAbortedException
from bibtexparser.model import Entry, ParsingFailedBlock

from plugin.schema import to_record

# The citation key of an entry the parser gave up on: `@article{key,`.
FAILED_KEY = re.compile(r"^\s*@\w+\s*\{\s*([^,\s]+)\s*,")
VERDICTS = "verdicts.json"


def resolve_path(workspace: Path, path: str) -> Path:
    """The file ``path`` names inside ``workspace``; it may not leave the workspace."""
    relative = Path(path)
    root = workspace.resolve()
    resolved = (root / relative).resolve()
    if relative.is_absolute() or ".." in relative.parts or not resolved.is_relative_to(root):
        raise ValueError("path must stay inside the plugin workspace")
    if not resolved.is_file():
        raise FileNotFoundError(f"no file at {path}")
    return resolved


def parse_file(path: Path) -> list[dict]:
    """Every entry of a BibTeX file, in file order: its key, and its schema record or why it has none."""
    library = bibtexparser.parse_string(path.read_text(encoding="utf-8"))
    entries = []
    for block in library.blocks:
        if isinstance(block, ParsingFailedBlock):
            key = FAILED_KEY.match(block.raw)
            if key is None:
                raise ValueError(f"{path.name} line {block.start_line + 1} is not an entry with a key")
            reason = block.error.abort_reason if isinstance(block.error, BlockAbortedException) else str(block.error)
            entries.append({"key": key.group(1), "record": None, "error": f"unparseable: {reason}"})
        elif isinstance(block, Entry):
            fields = [(field.key, field.value) for field in block.fields]
            try:
                entries.append({"key": block.key, "record": to_record(block.entry_type, fields), "error": None})
            except ValueError as error:
                entries.append({"key": block.key, "record": None, "error": f"not in the schema: {error}"})
    keys = [entry["key"] for entry in entries]
    twice = sorted({key for key in keys if keys.count(key) > 1})
    if twice:
        raise ValueError(f"{path.name} has these keys twice: {', '.join(twice)}")
    return entries


def parse_bibtex(reference: str, raw: str, *, workspace: Path) -> dict:
    """Both files' entries in the registered schema: the check-bibtex task's ground truth. Every
    reference entry must parse; a raw entry that does not is kept, with no record."""
    references = parse_file(resolve_path(workspace, reference))
    broken = [entry["key"] for entry in references if entry["record"] is None]
    if broken:
        raise ValueError(f"reference entries do not parse into the schema: {', '.join(broken)}")
    return {"ok": True, "reference": references, "raw": parse_file(resolve_path(workspace, raw))}


def read_bibtex(path: str, *, workspace: Path) -> dict:
    """One file's entries in the registered schema."""
    return {"ok": True, "path": path, "entries": parse_file(resolve_path(workspace, path))}


def submit_verdicts(verdicts: dict[str, str], *, workspace: Path) -> dict:
    """Write the verdicts, raw entry key -> `real` or `hallucinated`, to `verdicts.json`, replacing an
    earlier submission."""
    path = workspace.resolve() / VERDICTS
    path.write_text(json.dumps(verdicts, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "path": str(path), "verdicts": len(verdicts)}
