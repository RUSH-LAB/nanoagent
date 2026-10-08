"""The `docs/raw/` folder name of one paper: the same rules as src/plugin/naming.py."""

import re
import unicodedata

SHORT_NAME_WORDS = 4


def slug(text: str) -> str:
    """Lowercase ASCII words joined by `-`: "Łukasz Kaiser" -> "lukasz-kaiser"."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def raw_folder_name(title: str, authors: list[str], arxiv_id: str, date: str) -> str:
    """`{first_author_name}-{paper_short_name}-{arxiv_id}-{date}`: the first author's last name and
    the title's first four words."""
    first_author = slug(authors[0].split()[-1])
    short_name = "-".join(slug(title).split("-")[:SHORT_NAME_WORDS])
    return f"{first_author}-{short_name}-{arxiv_id}-{date}"
