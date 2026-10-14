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


def shared_fields(record, other):
    """The schema fields two records agree in, normalized: authors as the same names in the same order."""
    mine, theirs = _fields(record), _fields(other)
    return [
        field for field in mine if [None if value is None else normalize(value) for value in mine[field]]
        == [None if value is None else normalize(value) for value in theirs[field]]
    ]


def closest_reference(record, references):
    """(the reference entry closest to ``record``, the fields they share), or None when none is close.
    The closest shares the most fields, then the title or a DOI, then comes first. It is close when it
    shares the title, a DOI or at least four of the six fields."""
    best = None
    for entry in references:
        shared = shared_fields(record, entry.record)
        anchored = "title" in shared or (record.doi is not None and "doi" in shared)
        score = (len(shared), anchored)
        if best is None or score > best[0]:
            best = (score, entry, shared)
    if best is None or not (best[0][1] or best[0][0] >= 4):
        return None
    return best[1], best[2]


def record_problem(record):
    """What keeps ``record`` from being a normalized schema record, or None."""
    if not record.authors:
        return "authors must be a non-empty list"
    for field, values in _fields(record).items():
        if any(value is not None and normalize(value) != value for value in values):
            return f"{field} is not normalized text"
    return None
