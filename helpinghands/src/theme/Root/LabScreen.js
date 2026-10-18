import React, {useEffect, useRef, useState} from 'react';
import {apiRequest} from '@site/src/utils/api';
import {inLabApp, useConnectLink, useLabSetup} from '@site/src/utils/labApp';
import LabInstall from './LabInstall';
import styles from './authScreen.module.css';

// How often the screen asks whether RUSH Lab has connected.
const STATUS_MS = 5_000;

// The three phases of arriving in the app's window, each a tab of the screen.
const PHASES = [['account', 'Sign in'], ['computer', 'Set up this computer'], ['workspace', 'Open workspace']];

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
  const [phase, setPhase] = useState('computer');

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
    const phases = {account: 'done', computer: failure ? 'failed' : 'active', workspace: 'waiting'};
    // The stage the app is at, those before it done; none until the app says.
    const at = SETUP.findIndex(([id]) => id === setup?.stage);
    const stageOf = index => (index < at ? 'done' : index > at ? 'waiting' : failure ? 'failed' : 'active');
    return (
      <div className={styles.page}>
        <div className={`${styles.card} ${styles.setupCard}`}>
          <img src="/img/rush-lab.png" alt="" className={styles.logo} />
          <h1 className={styles.title}>Setting up RUSH Lab</h1>
          <p className={styles.tagline}>Getting this computer ready to run your AI and plugins.</p>
          <div className={styles.phases} role="tablist" aria-label="Setting up">
            {PHASES.map(([id, name]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={phase === id}
                className={`${styles.phase} ${PHASE_STYLES[phases[id]]}${phase === id ? ` ${styles.phaseSelected}` : ''}`}
                onClick={() => setPhase(id)}>
                <span className={styles.phaseDot} />
                <span className={styles.phaseName}>{name}</span>
              </button>
            ))}
          </div>
          <ol className={styles.progress} role="tabpanel" aria-live="polite">
            {phase === 'account' && <Step state="done" title="Signed in">Your account is on this computer.</Step>}
            {phase === 'computer' && (at === -1
              ? <Step state={failure ? 'failed' : 'active'} title="Connecting this computer">{failure ?? 'Waiting for RUSH Lab to start.'}</Step>
              : SETUP.map(([id, title, detail], index) => (
                <Step key={id} state={stageOf(index)} title={title}>{stageOf(index) === 'failed' ? failure : detail}</Step>
              )))}
            {phase === 'workspace' && <Step state="waiting" title="Open your workspace">It opens by itself once this computer is connected.</Step>}
          </ol>
          {failure && (
            <button type="button" className={styles.submit} onClick={() => window.location.reload()}>
              Try again
            </button>
          )}
          <button type="button" className={styles.switch} onClick={onSignOut}>
            Sign out
          </button>
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

// Each phase's dot, by its state.
const PHASE_STYLES = {done: styles.phaseDone, active: styles.phaseActive, failed: styles.phaseFailed, waiting: styles.phaseWaiting};

// Each step's mark and title, by its state.
const STEP_STYLES = {done: styles.progressDone, active: styles.progressActive, failed: styles.progressFailed, waiting: styles.progressWaiting};

/** One step of setting up: its mark, its title, and what it means, or why it failed. */
function Step({state, title, children}) {
  return (
    <li className={STEP_STYLES[state]}>
      <span className={styles.progressTitle}>{title}</span>
      <span className={state === 'failed' ? styles.progressWhy : styles.progressDetail}>{children}</span>
    </li>
  );
}
