"""The registered schema one BibTeX entry is compared in: the same rules as src/plugin/schema.py."""

FIELDS = ("entry_type", "title", "authors", "year", "venue", "doi")
# Fields that may be null: an entry need not have a venue or a DOI.
OPTIONAL = ("venue", "doi")


def normalize(text: str) -> str:
    """Drop braces and collapse whitespace, nothing else: "{A}ttention  is" -> "Attention is"."""
    return " ".join(text.replace("{", "").replace("}", "").split())


def match_key(record):
    """What an exact match compares: every schema field, normalized; the citation key is not one."""
    return tuple(
        tuple(normalize(name) for name in record["authors"])
        if field == "authors"
        else None if record[field] is None else normalize(record[field])
        for field in FIELDS
    )


def record_problem(record):
    """What keeps ``record`` from being a normalized schema record, or None."""
    if not isinstance(record, dict) or sorted(record) != sorted(FIELDS):
        return f"record must have exactly the fields {', '.join(FIELDS)}"
    authors = record["authors"]
    if not isinstance(authors, list) or not authors:
        return "authors must be a non-empty list"
    for field in FIELDS:
        values = authors if field == "authors" else [record[field]]
        for value in values:
            if value is None and field in OPTIONAL:
                continue
            if not isinstance(value, str) or normalize(value) != value:
                return f"{field} is not normalized text"
    return None
