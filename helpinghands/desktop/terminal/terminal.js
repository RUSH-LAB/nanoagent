/**
 * RUSH Lab's terminal window: one shell of the member's, in a PTY of the app's
 * (src-tauri/src/terminal.rs). Its bytes go only between this page and the app, never through
 * the site or the relay. The toolbar starts a plugin project or opens one, each in a window of
 * its own, so nothing is ever typed into a shell already running.
 */
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {Channel, invoke} from '@tauri-apps/api/core';

const banner = document.getElementById('error');
const status = document.getElementById('status');
const newButton = document.getElementById('new-plugin');
const newForm = document.getElementById('new-form');
const newId = document.getElementById('new-id');
const projects = document.getElementById('open-project');

/** Show why something failed, until it is clicked away. */
function fail(error) {
  banner.textContent = String(error);
  banner.hidden = false;
}
banner.addEventListener('click', () => { banner.hidden = true; });

// A link opens in the browser: the window hands every new window to it, by its address.
const openLink = (_event, uri) => window.open(uri);
const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: 13,
  theme: {background: '#1e1e1e'},
  // A link a program marks (OSC 8, as claude, gh and ls --hyperlink print).
  linkHandler: {activate: openLink},
});
const fit = new FitAddon();
terminal.loadAddon(fit);
// A link that is plain text.
terminal.loadAddon(new WebLinksAddon(openLink));
terminal.open(document.getElementById('terminal'));
fit.fit();

async function start() {
  const output = new Channel();
  output.onmessage = bytes => terminal.write(new Uint8Array(bytes));
  const exited = new Channel();
  exited.onmessage = code => terminal.write(`\r\n[process exited ${code ?? 'without a code'}]\r\n`);
  const id = await invoke('terminal_start', {cols: terminal.cols, rows: terminal.rows, output, exited});
  terminal.onData(data => invoke('terminal_write', {id, data}).catch(fail));
  terminal.onResize(({cols, rows}) => invoke('terminal_resize', {id, cols, rows}).catch(fail));
  new ResizeObserver(() => fit.fit()).observe(document.getElementById('terminal'));
  terminal.focus();
}

/** The projects there are, in the Open project list. */
async function listProjects() {
  const found = await invoke('terminal_projects');
  projects.replaceChildren(projects.options[0], ...found.map(project => {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.id;
    option.title = project.folder;
    return option;
  }));
}

newButton.addEventListener('click', () => {
  newButton.hidden = true;
  newForm.hidden = false;
  newId.focus();
});

function closeForm() {
  newForm.hidden = true;
  newButton.hidden = false;
  newId.value = '';
  terminal.focus();
}
document.getElementById('new-cancel').addEventListener('click', closeForm);

newForm.addEventListener('submit', async event => {
  event.preventDefault();
  const id = newId.value.trim();
  newForm.querySelectorAll('input, button').forEach(element => { element.disabled = true; });
  status.textContent = `Creating ${id}…`;
  try {
    await invoke('terminal_new_project', {id});
    closeForm();
  } catch (error) {
    fail(error);
  } finally {
    status.textContent = '';
    newForm.querySelectorAll('input, button').forEach(element => { element.disabled = false; });
  }
});

// Listed again each time the window comes to the front, as another window may have made one.
window.addEventListener('focus', () => listProjects().catch(fail));
projects.addEventListener('change', () => {
  const id = projects.value;
  projects.value = '';
  if (id) invoke('terminal_open_project', {id}).catch(fail);
});

listProjects().catch(fail);
start().catch(fail);
