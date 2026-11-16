/**
 * How a member gets Docker, per OS: the one place the commands and links live. runner/worker.mjs words its fixes from the links and
 * sends `platform` (process.platform of the member's computer) in the worker state; the Local Runner Health Check tab shows the
 * commands for that platform. No Node imports: the browser loads this too. Docker is never installed for the member, only explained.
 */

export const LINK = {
  desktop: 'https://www.docker.com/products/docker-desktop/',
  colima: 'https://github.com/abiosoft/colima',
  engine: 'https://docs.docker.com/engine/install/',
  homebrew: 'https://brew.sh',
};

// Each option: a title, optional steps to do by hand, and the commands (run in order, each with a copy button).
const INSTALL = {
  darwin: [
    {title: 'Docker Desktop', commands: ['brew install --cask docker'], then: 'Open Docker.app once.'},
    {title: 'Colima (free, command line only)', commands: ['brew install colima docker', 'colima start --cpu 4 --memory 8']},
  ],
  win32: [
    {title: 'Docker Desktop (WSL 2 backend)', commands: ['winget install -e --id Docker.DockerDesktop']},
  ],
  linux: [
    {title: 'Docker Engine', commands: ['curl -fsSL https://get.docker.com | sh', 'sudo usermod -aG docker $USER'], then: 'Log out and back in.'},
  ],
};

const START = {
  darwin: [
    {title: 'Docker Desktop', then: 'Open Docker Desktop.'},
    {title: 'Colima', commands: ['colima start']},
  ],
  win32: [{title: 'Docker Desktop', then: 'Open Docker Desktop.'}],
  linux: [{title: 'Docker Engine', commands: ['sudo systemctl start docker']}],
};

const platformOf = platform => (platform === 'darwin' || platform === 'win32' ? platform : 'linux');

/** The install options for `platform`: [{title, commands?, then?}]. */
export const installOptions = platform => INSTALL[platformOf(platform)];

/** The start options for an installed Docker that is not running. */
export const startOptions = platform => START[platformOf(platform)];

/** Homebrew's link, for macOS only: its absence is the member's to fix, not scripted. */
export const homebrewLink = platform => (platform === 'darwin' ? LINK.homebrew : null);
