from __future__ import annotations

import io
import tarfile
from urllib.request import Request

FEED = """<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">{entries}</feed>"""
ENTRY = """<entry>
  <id>http://arxiv.org/abs/{arxiv_id}</id>
  <title>{title}
    Wrapped</title>
  <summary> An abstract. </summary>
  <published>2017-06-12T17:57:34Z</published>
  <author><name>Ashish Vaswani</name></author>
  <author><name>Noam Shazeer</name></author>
</entry>"""


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def tar_bytes(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


def feed(*arxiv_ids: str) -> bytes:
    entries = "".join(ENTRY.format(arxiv_id=arxiv_id, title=f"Paper {arxiv_id}") for arxiv_id in arxiv_ids)
    return FEED.format(entries=entries).encode()


class FakeArxiv:
    """Answers the search API with ``arxiv_ids`` and every e-print with a one-file archive."""

    def __init__(self, *arxiv_ids: str) -> None:
        self.arxiv_ids = arxiv_ids
        self.urls: list[str] = []

    def __call__(self, request: Request) -> Response:
        self.urls.append(request.full_url)
        if "/api/query?id_list=" in request.full_url:
            return Response(feed(request.full_url.split("id_list=", 1)[1].split("&", 1)[0]))
        if "/api/query?" in request.full_url:
            return Response(feed(*self.arxiv_ids))
        paper = request.full_url.rsplit("/e-print/", 1)[1]
        return Response(tar_bytes({"main.tex": paper.encode()}))
