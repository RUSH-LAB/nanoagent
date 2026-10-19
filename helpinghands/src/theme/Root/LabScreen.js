import React, {useEffect, useRef} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {inLabApp, useConnectLink, useLabSetup} from '@site/src/utils/labApp';
import LabInstall from './LabInstall';
import styles from './authScreen.module.css';

// How often the screen asks whether RUSH Lab has connected.
const STATUS_MS = 5_000;

// What RUSH Lab does to set this computer up, in the order it does it, by the stage the app
// reports (useLabSetup): its title, and what it means.
const SETUP = [
  ['install', 'Install RUSH Lab', 'Puts RUSH Lab\'s parts on this computer.'],
  ['python', 'Prepare Python', 'The first time, this downloads Python. It takes about a minute.'],
  ['nanoagent', 'Start your AI', 'Starts NanoAgent, which runs your AI and plugins here.'],
  ['connect', 'Connect to your account', 'Joins this computer to your account, so your runs come here.'],
];

/**
 * What a signed-in member sees until RUSH Lab on their computer is connected.
 *
 * Every AI run goes to the member's own computer (server/runner.js), so the site
 * is not entered without it: the screen offers the app (LabInstall.js), in whose
 * window the member signs in, which connects it, and lets them in here by itself
 * once it connects. In the
 * app's own window, this computer is the app's, so the screen hands it the link
 * at once, and the app connects it. Rendered from the same stylesheet as
 * AuthScreen and OnboardingScreen, as the last step of arriving.
 */
export default function LabScreen({onConnected, onSignOut}) {
  const {link, error} = useConnectLink();
  const inApp = inLabApp();
  const handed = useRef(false);
  const setup = useLabSetup();

  // Once: the app follows the link itself (the page stays), and says so if it cannot connect.
  useEffect(() => {
    if (!inApp || !link || handed.current) return;
    handed.current = true;
    window.location.href = link;
  }, [inApp, link]);

  useEffect(() => {
    const timer = setInterval(() => apiRequest('/api/runner/status')
      .then(status => { if (status.connected) onConnected(); })
      .catch(() => {}), STATUS_MS);
    return () => clearInterval(timer);
  }, [onConnected]);

  if (inApp) {
    const failure = error ?? setup?.error ?? null;
    // The stage the app is at, those before it done; none until the app says.
    const at = SETUP.findIndex(([id]) => id === setup?.stage);
    const stageOf = index => (index < at ? 'done' : index > at ? 'waiting' : failure ? 'failed' : 'active');
    return (
      <div className={styles.page}>
        <div className={`${styles.card} ${styles.setupCard}`}>
          <header className={styles.setupHeader}>
            <img src="/img/rush-lab.png" alt="" className={styles.setupLogo} />
            <span className={styles.setupBrand}>RUSH Lab</span>
            <button type="button" className={styles.setupSignOut} onClick={onSignOut}>Sign out</button>
          </header>
          <h1 className={styles.setupTitle}>{failure ? 'Setup stopped' : 'Setting up this computer'}</h1>
          <p className={styles.setupLead}>
            {failure ? 'One step could not finish. See why below, then try again.' : 'Getting it ready to run your AI and plugins. Your workspace opens by itself when it is done.'}
          </p>
          <div className={styles.setupPanel} aria-live="polite">
            <Group name="Account">
              <Step state="done" title="Signed in" />
            </Group>
            <Group name="This computer" count={`${Math.max(at, 0)} / ${SETUP.length}`}>
              {at === -1
                ? <Step state={failure ? 'failed' : 'active'} title="Connecting this computer">{failure ?? 'Waiting for RUSH Lab to start.'}</Step>
                : SETUP.map(([id, title, detail], index) => (
                  <Step key={id} state={stageOf(index)} title={title}>{stageOf(index) === 'failed' ? failure : detail}</Step>
                ))}
            </Group>
            <Group name="Workspace">
              <Step state="waiting" title="Open your workspace" />
            </Group>
          </div>
          {failure && (
            <button type="button" className={`${styles.submit} ${styles.setupRetry}`} onClick={() => window.location.reload()}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <img src="/img/rush-lab.png" alt="" className={styles.logo} />
        <h1 className={styles.title}>Install RUSH Lab</h1>
        <p className={styles.tagline}>Your AI and plugins run on your own computer, in the RUSH Lab app. Install it, then sign in in its window: it connects this computer, and this page lets you in.</p>
        <LabInstall />
        {error && <p className={styles.error} role="alert">{error}</p>}
        <button type="button" className={styles.switch} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

// What each step's state is called, beside it.
const STATE_LABELS = {done: 'Done', active: 'Running', failed: 'Failed', waiting: ''};

/** One group of steps, with its name and, if given, how far it has got. */
function Group({name, count, children}) {
  return (
    <section className={styles.setupGroup}>
      <h2 className={styles.setupGroupName}>
        <span>{name}</span>
        {count && <span>{count}</span>}
      </h2>
      <ol className={styles.setupSteps}>{children}</ol>
    </section>
  );
}

/** One step of setting up: its mark, its title, its state and, while it runs or once it fails, what it means or why. */
function Step({state, title, children}) {
  const shown = state === 'active' || state === 'failed';
  return (
    <li className={`${styles.setupStep} ${styles[`setup_${state}`]}`}>
      <span className={styles.setupMark} aria-hidden="true" />
      <span className={styles.setupStepTitle}>{title}</span>
      <span className={styles.setupState}>{STATE_LABELS[state]}</span>
      {shown && children && <span className={styles.setupDetail}>{children}</span>}
    </li>
  );
}
