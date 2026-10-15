import {useEffect, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {clientPlatform} from '@site/src/platform/client';

// How often the install command is asked for again: its download token lasts an hour.
const INSTALL_MS = 30 * 60_000;

export const INSTALL_HINT = 'It installs RUSH Lab on this computer, to run in the background, connected to your account. macOS and Linux; on Windows, in WSL. The command is yours: keep it to yourself.';

/**
 * The line that installs RUSH Lab on the member's computer, to paste in a terminal
 * (server/routes/lab.js), and copying it: {command, note, copy}.
 */
export function useInstallCommand() {
  const [command, setCommand] = useState(null);
  const [note, setNote] = useState(null);
  useEffect(() => {
    const load = () => apiRequest('/api/lab/install')
      .then(value => {
        setCommand(value.command);
        setNote(current => (current?.error ? null : current));
      })
      .catch(err => setNote({error: err.message}));
    load();
    const timer = setInterval(load, INSTALL_MS);
    return () => clearInterval(timer);
  }, []);
  const copy = () => clientPlatform.clipboard.writeText(command)
    .then(() => setNote({text: 'Copied. Paste it in a terminal.'}))
    .catch(err => setNote({error: err.message}));
  return {command, note, copy};
}
