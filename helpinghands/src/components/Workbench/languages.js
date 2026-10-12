import {indentUnit, LanguageDescription, LanguageSupport, StreamLanguage} from '@codemirror/language';
import {Compartment} from '@codemirror/state';
import {EditorView, ViewPlugin} from '@codemirror/view';

const legacy = parser => new LanguageSupport(StreamLanguage.define(parser));

// Every language the editor knows: the files it opens (exact filenames win over
// extensions), its highlighter, loaded on first use, its indent unit, and
// whether long lines wrap. Markdown also highlights fenced code with this table.
const LANGUAGES = [
  {name: 'Markdown', extensions: ['md', 'mdx', 'markdown'], wrap: true,
    load: () => import('@codemirror/lang-markdown').then(({markdown}) => markdown({codeLanguages}))},
  {name: 'Python', alias: ['py'], extensions: ['py'], indent: '    ',
    load: () => import('@codemirror/lang-python').then(({python}) => python())},
  {name: 'JSON', extensions: ['json'], load: () => import('@codemirror/lang-json').then(({json}) => json())},
  {name: 'JavaScript', alias: ['js'], extensions: ['js', 'mjs', 'cjs'],
    load: () => import('@codemirror/lang-javascript').then(({javascript}) => javascript())},
  {name: 'JavaScript JSX', alias: ['jsx'], extensions: ['jsx'],
    load: () => import('@codemirror/lang-javascript').then(({javascript}) => javascript({jsx: true}))},
  {name: 'TypeScript', alias: ['ts'], extensions: ['ts', 'mts', 'cts'],
    load: () => import('@codemirror/lang-javascript').then(({javascript}) => javascript({typescript: true}))},
  {name: 'TypeScript JSX', alias: ['tsx'], extensions: ['tsx'],
    load: () => import('@codemirror/lang-javascript').then(({javascript}) => javascript({jsx: true, typescript: true}))},
  {name: 'CSS', extensions: ['css'], load: () => import('@codemirror/lang-css').then(({css}) => css())},
  {name: 'HTML', extensions: ['html', 'htm'], load: () => import('@codemirror/lang-html').then(({html}) => html())},
  {name: 'LaTeX', alias: ['tex'], extensions: ['tex', 'sty', 'cls', 'bib', 'bbl'], wrap: true,
    load: () => import('@codemirror/legacy-modes/mode/stex').then(({stex}) => legacy(stex))},
  {name: 'YAML', alias: ['yml'], extensions: ['yaml', 'yml'],
    load: () => import('@codemirror/legacy-modes/mode/yaml').then(({yaml}) => legacy(yaml))},
  {name: 'Shell', alias: ['sh', 'bash', 'zsh'], extensions: ['sh', 'bash', 'zsh'],
    load: () => import('@codemirror/legacy-modes/mode/shell').then(({shell}) => legacy(shell))},
  {name: 'TOML', extensions: ['toml'], load: () => import('@codemirror/legacy-modes/mode/toml').then(({toml}) => legacy(toml))},
  {name: 'Dockerfile', alias: ['docker'], filenames: ['Dockerfile', 'Containerfile'], extensions: ['dockerfile'],
    load: () => import('@codemirror/legacy-modes/mode/dockerfile').then(({dockerFile}) => legacy(dockerFile))},
  {name: 'Makefile', filenames: ['Makefile', 'GNUmakefile', 'makefile'], extensions: ['mk'], indent: '\t'},
].map(({load, ...language}) => ({
  ...language,
  description: load && LanguageDescription.of({name: language.name, alias: language.alias, extensions: language.extensions, load}),
}));

const PLAIN_TEXT = {name: 'Plain Text', extensions: []};

/** Markdown, for editors that only ever hold it. */
export const markdownLanguage = LANGUAGES.find(language => language.name === 'Markdown');

/** The languages fenced code in Markdown can name. */
export const codeLanguages = LANGUAGES.filter(language => language.description).map(language => language.description);

/** The language of the file at `path`: its exact filename first, then its extension. */
export function languageFor(path) {
  const name = path.split('/').at(-1);
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return LANGUAGES.find(language => language.filenames?.includes(name))
    ?? LANGUAGES.find(language => language.extensions.includes(extension))
    ?? PLAIN_TEXT;
}

/**
 * The editor extensions for `language`: its indent unit and wrapping, and a
 * compartment its highlighter fills once loaded.
 */
export function languageExtensions(language) {
  const highlighter = new Compartment();
  const {description} = language;
  return [
    indentUnit.of(language.indent ?? '  '),
    language.wrap ? EditorView.lineWrapping : [],
    highlighter.of(description?.support ?? []),
    description && !description.support ? ViewPlugin.define(view => {
      let open = true;
      description.load().then(support => {
        if (open) view.dispatch({effects: highlighter.reconfigure(support)});
      });
      return {destroy: () => { open = false; }};
    }) : [],
  ];
}
