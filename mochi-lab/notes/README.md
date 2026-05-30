# Bibliography Notes

This directory is the note-taking space for the central bibliography. Each
reference in `references.yaml` can have a companion note file here.

## Convention

Create a file named after the citation key:

```
notes/{key}.md
```

For example, notes on `[@hinton2015distilling]` go in
`notes/hinton2015distilling.md`.

The content is loaded automatically by the bibliography plugin and rendered in
the **Notes** section of that reference's page at `/bibliography/{key}`. No
restart is needed in dev — saving the file refreshes the page.

## What to write

Anything useful: a summary, key results, how the work relates to our projects,
open questions, or quotes worth citing. Plain Markdown.
