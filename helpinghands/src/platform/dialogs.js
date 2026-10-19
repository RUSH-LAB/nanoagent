/**
 * The site's own alert, confirm and prompt, drawn in the page as a modal <dialog>: a browser tab and
 * RUSH Lab's window show the same one. In the window Tauri's dialog plugin replaces window.alert and
 * window.confirm, whose calls are refused without a permission and whose confirm answers later, with
 * a Promise. Each of these returns a Promise of the answer; nothing in the site calls window.alert,
 * window.confirm or window.prompt (tests/unit/src/dialogs.test.mjs).
 */
import styles from './dialogs.module.css';

const OK = 'ok';

/** Show a dialog of `message`, with `input` above its buttons; resolve with `answer` of whether it closed with OK. */
function show({message, input, cancellable, answer}) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = styles.dialog;
    const form = document.createElement('form');
    form.method = 'dialog';
    const text = document.createElement('p');
    text.className = styles.message;
    text.textContent = message;
    form.append(text);
    if (input) form.append(input);
    const buttons = document.createElement('div');
    buttons.className = styles.buttons;
    if (cancellable) {
      const cancel = document.createElement('button');
      cancel.type = 'submit';
      cancel.value = '';
      cancel.formNoValidate = true;
      cancel.className = `${styles.button} ${styles.cancel}`;
      cancel.textContent = 'Cancel';
      buttons.append(cancel);
    }
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.value = OK;
    ok.className = `${styles.button} ${styles.ok}`;
    ok.textContent = 'OK';
    buttons.append(ok);
    form.append(buttons);
    dialog.append(form);
    // Escape and Cancel close it with no value; Enter in the field and OK close it with OK.
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === OK;
      dialog.remove();
      resolve(answer(confirmed));
    });
    document.body.append(dialog);
    dialog.showModal();
    (input ?? ok).focus();
    input?.select();
  });
}

/** Tell the member `message`; resolves once they dismiss it. */
export function alert(message) {
  return show({message: String(message), cancellable: false, answer: () => undefined});
}

/** Ask the member to confirm `message`; resolves to whether they did. */
export function confirm(message) {
  return show({message: String(message), cancellable: true, answer: confirmed => confirmed});
}

/** Ask the member for text; resolves to what they entered, or null when they cancelled. */
export function prompt(message, defaultValue = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = styles.input;
  input.value = defaultValue;
  return show({message: String(message), input, cancellable: true, answer: confirmed => (confirmed ? input.value : null)});
}
