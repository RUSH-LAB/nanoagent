"""The registered schema one BibTeX entry is compared in: the same rules as src/plugin/schema.py."""


def normalize(text: str) -> str:
    """Drop braces and collapse whitespace, nothing else: "{A}ttention  is" -> "Attention is"."""
    return " ".join(text.replace("{", "").replace("}", "").split())


def _fields(record):
    """Each schema field's texts: the authors' names, or the one value, null for a missing venue or DOI."""
    return {
        "entry_type": [record.entry_type],
        "title": [record.title],
        "authors": record.authors,
        "year": [record.year],
        "venue": [record.venue],
        "doi": [record.doi],
    }


def match_key(record):
    """What an exact match compares: every schema field, normalized; the citation key is not one."""
    return tuple(
        tuple(None if value is None else normalize(value) for value in values) for values in _fields(record).values()
    )


def record_problem(record):
    """What keeps ``record`` from being a normalized schema record, or None."""
    if not record.authors:
        return "authors must be a non-empty list"
    for field, values in _fields(record).items():
        if any(value is not None and normalize(value) != value for value in values):
            return f"{field} is not normalized text"
    return None
