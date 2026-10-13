import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState} from '@codemirror/state';
import {ensureSyntaxTree, indentUnit, language, LanguageDescription} from '@codemirror/language';
import {EditorView} from '@codemirror/view';
import {
  codeLanguages, languageExtensions, languageFor, markdownLanguage,
} from '../../../../src/components/Workbench/languages.js';

describe('workbench languages', () => {
  it('matches exact filenames before extensions', () => {
    assert.equal(languageFor('build/Dockerfile').name, 'Dockerfile');
    assert.equal(languageFor('Makefile').name, 'Makefile');
    assert.equal(languageFor('docs/notes.MD').name, 'Markdown');
    assert.equal(languageFor('docs/intro.mdx').name, 'Markdown');
    assert.equal(languageFor('LICENSE').name, 'Plain Text');
  });

  it('sets the indent unit and wrapping per language', () => {
    const state = language => EditorState.create({extensions: languageExtensions(languageFor(language))});
    assert.equal(state('a.py').facet(indentUnit), '    ');
    assert.equal(state('Makefile').facet(indentUnit), '\t');
    assert.equal(state('a.js').facet(indentUnit), '  ');
    assert.equal(state('a.md').facet(EditorView.contentAttributes).some(attrs => attrs.class === 'cm-lineWrapping'), true);
    assert.equal(state('a.js').facet(EditorView.contentAttributes).some(attrs => attrs.class === 'cm-lineWrapping'), false);
  });

  it('names fenced code languages by name or alias', () => {
    assert.equal(LanguageDescription.matchLanguageName(codeLanguages, 'py', false).name, 'Python');
    assert.equal(LanguageDescription.matchLanguageName(codeLanguages, 'bash', false).name, 'Shell');
    assert.equal(LanguageDescription.matchLanguageName(codeLanguages, 'Dockerfile', false).name, 'Dockerfile');
  });

  it('starts an editor with a highlighter already loaded', async () => {
    const support = await markdownLanguage.description.load();
    const state = EditorState.create({extensions: languageExtensions(markdownLanguage)});
    assert.equal(state.facet(language), support.language);
  });

  it('highlights fenced code in Markdown', async () => {
    await markdownLanguage.description.load();
    await languageFor('a.py').description.load();
    const doc = '# Title\n\n```py\nx = 1\n```\n';
    const state = EditorState.create({doc, extensions: languageExtensions(markdownLanguage)});
    const tree = ensureSyntaxTree(state, doc.length, 1e9);
    assert.equal(tree.resolveInner(doc.indexOf('x = 1') + 1, 1).name, 'AssignStatement');
  });
});
