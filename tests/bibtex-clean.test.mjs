import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// research-tools.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');
const { cleanBibtexValue } = researchTools;

describe('cleanBibtexValue', () => {
  it('is exported as a function on module.exports', () => {
    assert.equal(typeof cleanBibtexValue, 'function');
  });

  // The characters the GOAL calls out explicitly.
  it('escapes ampersand, underscore, and percent', () => {
    assert.equal(cleanBibtexValue('AT&T'), 'AT\\&T');
    assert.equal(cleanBibtexValue('a_b'), 'a\\_b');
    assert.equal(cleanBibtexValue('100%'), '100\\%');
  });

  it('escapes the remaining backslash-prefixed specials', () => {
    assert.equal(cleanBibtexValue('$5'), '\\$5');
    assert.equal(cleanBibtexValue('#1'), '\\#1');
    assert.equal(cleanBibtexValue('a{b}c'), 'a\\{b\\}c');
  });

  it('escapes tilde and caret as text commands, not bare accents', () => {
    // A bare \~ or \^ is an accent command expecting an argument; the literal
    // glyph needs the explicit text form so the field still compiles.
    assert.equal(cleanBibtexValue('a~b'), 'a\\textasciitilde{}b');
    assert.equal(cleanBibtexValue('a^b'), 'a\\textasciicircum{}b');
  });

  it('escapes a literal backslash as \\textbackslash{}', () => {
    assert.equal(cleanBibtexValue('a\\b'), 'a\\textbackslash{}b');
  });

  it('does not double-escape the backslashes it introduces', () => {
    // A single pass over the original string means the backslash added for `&`
    // is never itself re-escaped: `&` stays exactly `\&`, not `\textbackslash{}&`.
    assert.equal(cleanBibtexValue('&'), '\\&');
    assert.equal(cleanBibtexValue('a & b'), 'a \\& b');
    // A literal backslash adjacent to an original special: each original character
    // is rewritten exactly once, so the brace from \textbackslash{} never cascades.
    assert.equal(cleanBibtexValue('a\\&b'), 'a\\textbackslash{}\\&b');
  });

  it('escapes several specials together in one value', () => {
    assert.equal(cleanBibtexValue('100% & $5 in #1'), '100\\% \\& \\$5 in \\#1');
  });

  it('collapses internal whitespace runs and trims the ends', () => {
    assert.equal(cleanBibtexValue('a   b'), 'a b');
    assert.equal(cleanBibtexValue('  hello   world  '), 'hello world');
    assert.equal(cleanBibtexValue('line1\n\n\tline2'), 'line1 line2');
    // A whitespace-only value collapses to a single space then trims to empty,
    // so the export emits `{}` rather than `{ }`.
    assert.equal(cleanBibtexValue('   '), '');
  });

  it('leaves ordinary text untouched', () => {
    assert.equal(cleanBibtexValue('Attention Is All You Need'), 'Attention Is All You Need');
  });

  it('coerces null, undefined, and numbers to clean strings', () => {
    assert.equal(cleanBibtexValue(null), '');
    assert.equal(cleanBibtexValue(undefined), '');
    assert.equal(cleanBibtexValue(''), '');
    assert.equal(cleanBibtexValue(2024), '2024');
    // The `== null` guard keeps a falsy-but-real 0, where a `|| ''` guard would drop it.
    assert.equal(cleanBibtexValue(0), '0');
  });

  // Mirror how /api/references/export builds a field line, to show the value lands
  // properly escaped inside the {...} braces while the field name stays untouched.
  it('produces compile-safe BibTeX field lines for messy values', () => {
    const field = (name, value) => `  ${name} = {${cleanBibtexValue(value)}}`;
    assert.equal(field('title', 'Scaling & Efficiency: 100% Faster'),
      '  title = {Scaling \\& Efficiency: 100\\% Faster}');
    assert.equal(field('author', 'A_B and C_D'),
      '  author = {A\\_B and C\\_D}');
  });
});
