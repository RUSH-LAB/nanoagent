# Mochi Paper Protocol v1

Every bibliography entry uses the schema identifier `mochi.paper/1`.

```yaml
schema: mochi.paper/1
type: article
title: Attention Is All You Need
author:
  - Ashish Vaswani
year: 2017
venue: NeurIPS
doi: 10.5555/3295222.3295349
arxivId: 1706.03762
source:
  type: doi
  id: 10.5555/3295222.3295349
  url: https://doi.org/10.5555/3295222.3295349
  provider: crossref
officialUrl: https://doi.org/10.5555/3295222.3295349
pdfUrl: https://arxiv.org/pdf/1706.03762.pdf
tags:
  - transformers
  - foundational
```

Required fields are `schema`, `title`, `author`, `source`, and `tags`. Citation
fields use familiar BibTeX names so the format remains easy to edit and export.

`source` records where the identity or metadata came from. Its `type` is one of
`doi`, `arxiv`, `publisher`, `url`, `bibtex`, or `manual`. `officialUrl` is the
canonical landing page a reader should visit. `pdfUrl` is a directly viewable
PDF and may be either HTTPS or a workspace-local path. These are intentionally
separate: a DOI page is usually official but is not itself a PDF.

Tags are workspace-defined strings. They are trimmed, deduplicated without
regard to case, and kept in their first-entered display form.

Older entries remain valid input. The plugin derives the new fields from
`doi`, `arxivId`, and `url` at read time, so adopting the protocol does not
require rewriting an existing bibliography.

## Organization storage

The protocol describes a paper independently of its storage. At runtime each
organization owns separate `papers`, `files`, and `annotations` collections in
the database. The old `references.yaml` is imported once as migration input;
after that, the database is authoritative.

Uploaded PDF bytes are stored in an organization-scoped, content-addressed
blob directory. The database retains the file's hash, size, MIME type, original
name, uploader, and link to its paper. A paper's managed `pdfUrl` points back to
the authenticated PDF endpoint rather than exposing the storage path.

Annotations are separate organization-owned records. Each one names the paper,
managed file version, page, optional quoted text and note, author, color, and
optional PDF rectangles. This keeps the PDF immutable while letting every
member of the organization see the same annotation layer.
