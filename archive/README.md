# Archive

Artifacts that are worth keeping but are not part of the site, the build, or
the test suite. Nothing here is read by any code. Anything in this directory
can be deleted without affecting `npm run build` or `npm test`.

## `reviews/`

Rubric reviews of the book chapters and posts, produced by a single automated
review pass on 2026-05-30 and untouched since. Each file records the original
and post-revision scores for one document, plus the em-dash and broken-citekey
counts that pass checked for.

Paths mirror `content/`, so the review of
`content/books/math/2-ml-basics/3-gradient-descent.md` is at
`archive/reviews/books/math/2-ml-basics/3-gradient-descent.review.md`.

They lived beside their subjects under `content/` until 2026-08-27, hidden from
the build by a leading underscore. That underscore has been dropped here, since
outside `content/` it carries no meaning.
