---
name: ui
description: Make the UI of a page, component or plugin page better by picking the best-fitting DESIGN.md from github.com/voltagent/awesome-design-md and applying its principles. Use when the user types /ui or asks to "make the UI of X better", "improve the design of X", or "make X look better".
---

# Make the UI of something better

The user names a target ("the plugin sidebar", "the marketplace page", "the
Drafts section"). Find it, pick the DESIGN.md from
`voltagent/awesome-design-md` whose kind of product and surface fits it best,
and rework the target by that file's principles.

Stop and report at the first step that fails. Never work around a failure.

## 1. Find the target

Locate the files that render it. Most UI lives in `helpinghands/src/`:
`components/<Name>/` (an `index.js` and a `styles.module.css`), `pages/`,
`theme/`, and the global tokens in `src/css/custom.css`. Read the component,
its CSS module, and the parts of `custom.css` it uses.

If the target is ambiguous (two components match, or the name matches
nothing), ask the user which one they mean. Do not guess.

Write down what the target is for: what the member does there, what
information it shows, and what kind of surface it is (sidebar, list, form,
dashboard, reading page, dialog, empty state, marketing page).

## 2. Pick the DESIGN.md

List the design systems live, so new ones are included:

```bash
gh api 'repos/voltagent/awesome-design-md/git/trees/HEAD?recursive=1' \
  --jq '.tree[].path | select(endswith("/DESIGN.md"))'
```

Shortlist 3 candidates whose product is closest to the target's surface,
judged by function rather than looks. For example, Linear, Notion, Raycast
or Superhuman for dense app chrome and lists; Mintlify, Stripe or Vercel for
docs and reading pages; Supabase, PostHog or Sentry for dashboards and
tables; Cursor, Warp or OpenCode for terminal-style or CLI-adjacent surfaces.

Download each candidate into its own empty directory and read its
frontmatter `description` and its sections on layout, spacing, type and
components:

```bash
mkdir -p /tmp/ui-design/<slug>
curl -sSL https://raw.githubusercontent.com/voltagent/awesome-design-md/HEAD/design-md/<slug>/DESIGN.md \
  -o /tmp/ui-design/<slug>/DESIGN.md
```

Choose one and tell the user which one you chose and why in one or two
sentences, naming the runners-up. The downloaded files are reference only:
never copy them into the repo.

## 3. Apply the principles

Take the chosen file's principles, not its brand. That means its hierarchy,
density, spacing rhythm, type ramp proportions, borders over shadows (or the
reverse), how it uses its one accent color, component states (hover, focus,
active, disabled, empty, loading), and alignment.

Keep RUSH Lab's identity: the Inter font, the `--ifm-color-primary` family
and the layout widths in `src/css/custom.css`. Change them only when the user
asks. New values go in as CSS variables in `custom.css` and are used through
`var(...)`. Don't hard-code colors or sizes in a module. Every change must
work in both themes (`[data-theme='dark']`).

Keep what the component does. Don't remove features, rename commands or
change data flow to make it look better. If the design calls for a
structural change (regrouping, a new empty state, moving an action), make it
in the component's JSX, and keep it to that target.

## 4. Check it

Run RUSH with `npm start` (in `helpinghands/`) and look at the target in
light and dark themes, at a narrow and a wide window. If the target ships in
the desktop app (plugin pages, the sidebar, Drafts, anything the app's
webview renders), also run `npm run desktop:dev` and check it in the
`RUSH Lab Dev` window.

Then review every file you touched and cut it down to the smallest complete
change: no unused classes, no leftover variables, no debugging styles.

## 5. Report

Tell the user:
- which DESIGN.md you used, and why it fit the target
- the 3–5 principles you applied, each with the concrete change it made
- the files changed, and where you checked it (site, RUSH Lab Dev)

Do not commit unless the user asks.
