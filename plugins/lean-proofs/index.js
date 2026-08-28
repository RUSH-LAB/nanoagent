/**
 * Serves the Lake project in ./proofs as site data.
 *
 * The `.lean` files are the single source of truth for every formal proof on
 * the site. This plugin parses each declaration out of them at build time and
 * publishes it as global data, so `<LeanProof name="add_comm_demo" />` renders
 * the real, `lake build`-checked source instead of a copy pasted into MDX that
 * can silently drift from it.
 *
 * Nothing here invokes Lean. Verification stays a human step
 * (`cd plugins/lean-proofs/proofs && lake build`) so the site still builds on a
 * machine with no Lean toolchain installed.
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_NAME = 'lean-proofs';

/** A leading `/- ... -/` block comment documents the file, not a proof. */
const FILE_HEADER_RE = /^\s*\/-[\s\S]*?-\/\s*/;

/**
 * The declaration a chunk opens with, after any `--` comment lines.
 * Named forms capture their name; `example` is anonymous.
 */
const DECL_RE = /^(?:\s*--[^\n]*\n)*\s*(theorem|lemma|def|abbrev|instance|example)\b[ \t]*([A-Za-z_][A-Za-z0-9_'!?]*)?/;

/**
 * Split one Lean file into its top-level declarations.
 *
 * Blank lines separate declarations in these files, which keeps the parser to
 * a split rather than anything that pretends to understand Lean syntax. A
 * chunk that opens with no recognised keyword is skipped rather than guessed
 * at.
 */
function parseDeclarations(source, file) {
  const body = source.replace(FILE_HEADER_RE, '');
  const found = [];
  let anonymous = 0;

  for (const chunk of body.split(/\n\s*\n/)) {
    const text = chunk.trim();
    if (!text) continue;
    const match = DECL_RE.exec(text);
    if (!match) continue;
    const [, kind, declared] = match;
    anonymous += declared ? 0 : 1;
    found.push({
      name: declared || `${kind}-${anonymous}`,
      kind,
      file,
      source: text,
    });
  }
  return found;
}

module.exports = function leanProofsPlugin(context, options = {}) {
  const dir = path.resolve(__dirname, options.dir ?? 'proofs');

  return {
    name: PLUGIN_NAME,

    /** Editing a proof should reload the pages that show it. */
    getPathsToWatch() {
      return [path.join(dir, '**/*.lean')];
    },

    async loadContent() {
      let names;
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith('.lean'));
      } catch {
        return {proofs: {}, files: []};
      }

      const proofs = {};
      const duplicates = [];
      for (const name of names.sort()) {
        const source = fs.readFileSync(path.join(dir, name), 'utf8');
        for (const decl of parseDeclarations(source, name)) {
          // Two declarations sharing a name would make `name=` ambiguous, so
          // say so at build time rather than silently serving one of them.
          if (proofs[decl.name]) duplicates.push(decl.name);
          proofs[decl.name] = decl;
        }
      }
      if (duplicates.length) {
        throw new Error(
          `[${PLUGIN_NAME}] duplicate proof name(s): ${duplicates.join(', ')}. ` +
          'Each declaration must be uniquely named across the Lake project.',
        );
      }
      return {proofs, files: names};
    },

    async contentLoaded({content, actions}) {
      actions.setGlobalData(content);
    },
  };
};

module.exports.parseDeclarations = parseDeclarations;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
