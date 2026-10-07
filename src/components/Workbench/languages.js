import {css} from '@codemirror/lang-css';
import {html} from '@codemirror/lang-html';
import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {markdown} from '@codemirror/lang-markdown';
import {python} from '@codemirror/lang-python';
import {StreamLanguage} from '@codemirror/language';
import {shell} from '@codemirror/legacy-modes/mode/shell';
import {stex} from '@codemirror/legacy-modes/mode/stex';
import {toml} from '@codemirror/legacy-modes/mode/toml';
import {yaml} from '@codemirror/legacy-modes/mode/yaml';

// Extension → the language the editor highlights and the status bar names.
const LANGUAGES = [
  [['md', 'markdown'], 'Markdown', () => markdown()],
  [['py'], 'Python', () => python()],
  [['json'], 'JSON', () => json()],
  [['js', 'mjs', 'cjs'], 'JavaScript', () => javascript()],
  [['jsx'], 'JavaScript JSX', () => javascript({jsx: true})],
  [['ts', 'mts', 'cts'], 'TypeScript', () => javascript({typescript: true})],
  [['tsx'], 'TypeScript JSX', () => javascript({jsx: true, typescript: true})],
  [['css'], 'CSS', () => css()],
  [['html', 'htm'], 'HTML', () => html()],
  [['tex', 'sty', 'cls', 'bib', 'bbl'], 'LaTeX', () => StreamLanguage.define(stex)],
  [['yaml', 'yml'], 'YAML', () => StreamLanguage.define(yaml)],
  [['sh', 'bash', 'zsh'], 'Shell', () => StreamLanguage.define(shell)],
  [['toml'], 'TOML', () => StreamLanguage.define(toml)],
];

/** `{name, extensions}` for the file at `path`; plain text has no extensions. */
export function languageFor(path) {
  const extension = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  const found = LANGUAGES.find(([extensions]) => extensions.includes(extension));
  return found ? {name: found[1], extensions: [found[2]()]} : {name: 'Plain Text', extensions: []};
}
