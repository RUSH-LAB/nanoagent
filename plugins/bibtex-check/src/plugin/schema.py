"""The registered schema one BibTeX entry is compared in. verifier/schema.py holds the same rules."""

from __future__ import annotations

from contract import Record

# A venue is the journal or the proceedings the entry appeared in.
VENUE_FIELDS = ("journal", "booktitle")


def normalize(text: str) -> str:
    """Drop braces and collapse whitespace, nothing else: "{A}ttention  is" -> "Attention is"."""
    return " ".join(text.replace("{", "").replace("}", "").split())


def to_record(entry_type: str, pairs: list[tuple[str, str]]) -> Record:
    """The schema record of one entry: entry type, title, authors, year, venue and DOI. ``pairs`` are
    the entry's (field name, value) pairs; field names are case-insensitive and each appears once.
    Title, author and year are required, at most one venue field may be set, and a missing venue or
    DOI is null."""
    fields = {name.lower(): value for name, value in pairs}
    if len(fields) != len(pairs):
        raise ValueError("has a field twice")
    missing = [name for name in ("title", "author", "year") if not normalize(fields.get(name, ""))]
    if missing:
        raise ValueError(f"missing {', '.join(missing)}")
    venues = [normalize(fields[name]) for name in VENUE_FIELDS if name in fields]
    if len(venues) > 1:
        raise ValueError("has both a journal and a booktitle")
    return Record(
        entry_type=normalize(entry_type),
        title=normalize(fields["title"]),
        authors=normalize(fields["author"]).split(" and "),
        year=normalize(fields["year"]),
        venue=venues[0] if venues else None,
        doi=normalize(fields["doi"]) if "doi" in fields else None,
    )
