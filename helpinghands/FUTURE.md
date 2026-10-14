# Future

## Book and Blog as optional workspace features

Book and Blog are hidden for now: the navbar shows no Book or Blog item
(`src/theme/Navbar/Content/index.tsx`), and the command palette lists no
navigation entry inside a book or blog collection (`src/components/commands.js`).
Nothing else changed. A workspace's collections stay in its `workspace_settings`,
its pages still open by URL, and quick notes still save to its blog.

To decide:

- Where an owner turns Book and Blog on for a workspace, e.g. a Features section
  in workspace Settings.
- How it is stored. The existing per-workspace switch is
  `site.plugins.<name>.enabled` (`src/server/workspace-site.js`), which the
  server and client already check for plugins.
- What "off" means: only hidden from the navbar, or also its pages return 404,
  the book switcher (`src/theme/DocSidebar/Desktop/index.tsx`) is gone, and
  quick notes, feeds and search skip it.

Bringing back the navbar items: they are removed in the commit that added this
file, and `git show` on it restores the code.
