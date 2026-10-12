# Pages

One directory per route, each holding `index.js` plus whatever that page needs
(stylesheet, extracted sub-components). `src/pages/about/index.js` serves
`/about`.

Two files sit loose here rather than in a directory, and must stay that way:
`index.js` and its `index.module.css`. Docusaurus derives a route from the path
relative to this directory and only strips a trailing `index`, so
`src/pages/index.js` serves `/` while `src/pages/index/index.js` would serve
`/index` and leave the site without a homepage.

Every `.js` file under this directory becomes a route unless its name, or the
name of a directory above it, starts with an underscore. Anything a page needs
that is not itself a route therefore has to be an `_`-prefixed file, a
stylesheet, or a module under `src/components/`.
