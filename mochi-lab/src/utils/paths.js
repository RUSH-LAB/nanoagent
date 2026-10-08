/**
 * The one place a content source path becomes a site URL.
 *
 * There were six versions of this transform, and they did not agree. The graph
 * page and the search page got it right; Backlinks produced `/books/math/x` and
 * the mindmap page produced `/docs/books/math/x`, neither of which is a route
 * this site serves, so both had been emitting dead links. The server had five
 * more copies for the feeds and the sitemap, two of which had the same
 * `/books/...` defect. A rule worth writing once was written eleven times and
 * was wrong in four of them.
 *
 * The rule itself comes from docusaurus.config.js: each docs and blog plugin
 * takes the LAST segment of its content directory as its route base, so
 * `content/books/math` serves `/math` and `content/posts/blog` serves `/blog`.
 * The `books/` and `posts/` levels exist to organise the repository and never
 * appear in a URL.
 *
 * CommonJS, alone among the modules in this directory, because the server needs
 * it too. An ES module can name-import CommonJS anywhere, while requiring an ES
 * module from CommonJS needs Node 22.12, and nothing here pins a Node version.
 * The alternative was one copy per module system, which is how the six copies
 * above began.
 */

/** The extensions a content page can have, as a URL-stripping pattern. */
const PAGE_EXT_RE = /\.mdx?$/;

/**
 * `filePath` without the parts that are repository structure rather than
 * address: an optional leading `content/`, and the file extension.
 */
function withoutContentPrefix(filePath) {
  return String(filePath ?? '').replace(/^content\//, '').replace(PAGE_EXT_RE, '');
}

/**
 * A leading `12-` on a path segment. Docusaurus's docs plugin uses these only to
 * order the sidebar and drops them from the route, so `3-cuda-and-gpu` serves
 * `/cuda-and-gpu`. The blog plugin does no such thing, and a dated post is named
 * `2026-01-01-title`, so stripping there would turn the year into a path.
 */
const ORDER_PREFIX_RE = /^\d+-/;

/**
 * The site URL for a content source path, or '' when there is no path.
 *
 *     content/books/programming/3-cuda-and-gpu/1-first-kernel.md
 *                                          ->  /programming/cuda-and-gpu/first-kernel
 *     content/books/builder/how-to/index.md ->  /builder/how-to
 *     content/posts/blog/hello.md           ->  /blog/hello
 *     content/posts/research/swarms.md      ->  /research/eisi   (with slug: eisi)
 *
 * Accepts a path with or without the `content/` prefix, because both kinds reach
 * it: the API returns repository-relative paths, while the graph endpoint has
 * already made its node ids content-relative.
 *
 * A blog post's address is its frontmatter `slug`, which is not in its path, so
 * a caller that has read the frontmatter passes it. Callers that have only a
 * path fall back to the filename, which is right for the common case where a
 * post is named after its slug and wrong otherwise. Docs need no such help: for
 * them the path is the address.
 *
 * @param {string} filePath  A content source path.
 * @param {{slug?: string}} [options]  The post's frontmatter slug, if known.
 * @returns {string}  A site-absolute URL, or '' for empty input.
 */
function contentPathToUrl(filePath, {slug} = {}) {
  if (!filePath) return '';
  const bare = withoutContentPrefix(filePath);

  // The organising level decides the rules; it is never part of the URL.
  const organising = bare.match(/^(books|posts)\//);
  const rest = organising ? bare.slice(organising[0].length) : bare;
  const segments = rest.split('/');

  if (organising?.[1] === 'posts') {
    // `<route base>/<post>`, where the post's own name is the slug when the
    // caller knows it. Anything deeper is a post directory whose index.mdx is
    // addressed as the directory.
    const [routeBase, ...within] = segments;
    const last = within[within.length - 1];
    const name = slug || (last === 'index' ? within[within.length - 2] : last);
    return name ? `/${routeBase}/${name}` : `/${routeBase}`;
  }

  const route = segments
    .map(segment => (organising ? segment.replace(ORDER_PREFIX_RE, '') : segment))
    .join('/')
    // A directory's index page is addressed as the directory.
    .replace(/\/index$/, '')
    .replace(/^index$/, '');
  return `/${route}`;
}

/**
 * Render a content source path as its parent-directory label: strip the leading
 * `content/` prefix, then drop the final `/segment`. Shared by the homepage,
 * analytics, and timeline pages so the transform lives in exactly one place.
 *
 * A label, not a URL, which is why it keeps the `books/` and `posts/` levels
 * that contentPathToUrl drops: it answers "where is this file?" rather than
 * "where does this page live?".
 *
 * The `!filePath` guard returns '' for empty or undefined input, matching the
 * timeline page's former local helper and acting as a safe superset for the
 * inline call sites (whose paths are always truthy strings).
 *
 * @param {string} filePath  A content source path, e.g. 'content/books/foo/bar.md'.
 * @returns {string}  The parent-directory label, e.g. 'books/foo'.
 */
function displayDirPath(filePath) {
  if (!filePath) return '';
  return filePath.replace(/^content\//, '').replace(/\/[^/]+$/, '');
}

/**
 * A content source path with the `content/` prefix and extension removed, for
 * showing a file's identity without claiming it is a link.
 *
 *     content/books/math/0-intro.md  ->  books/math/0-intro
 */
function displayPagePath(filePath) {
  if (!filePath) return '';
  return withoutContentPrefix(filePath);
}

module.exports = {contentPathToUrl, displayDirPath, displayPagePath, PAGE_EXT_RE};
