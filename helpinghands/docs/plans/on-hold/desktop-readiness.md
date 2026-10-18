# Desktop readiness

RUSH Lab remains a web application for now. The goal of the current work is
to preserve that fast development loop while keeping operating-system
integration behind replaceable boundaries.

## Decisions

- React/Docusaurus remains the shared user interface.
- The Node API remains the application backend.
- Neon PostgreSQL remains the authoritative database in development and
  production. A desktop package must not introduce a SQLite fallback.
- Browser and desktop clients use the same authenticated HTTP API.
- `src/platform/client.js` owns client capabilities that a desktop shell may
  replace. Ordinary DOM rendering and layout stay in React.
- Secrets and provider keys remain on the server. The client stores only local
  interface state and recoverable drafts.

## Current platform contract

The web adapter currently supplies:

- runtime configuration, including an optional API base URL;
- local UI storage;
- clipboard writes;
- app navigation and reloads;
- confirmation dialogs; and
- notification capability detection and delivery.

The facade reports filesystem and terminal capabilities as unavailable on the
web. A future desktop bootstrap can call `installClientPlatform(adapter)` before
React mounts. Native filesystem and command implementations must validate
workspace scope and user approvals in the privileged process; this facade is
not itself a security boundary.

For a hosted desktop UI, inject runtime configuration before application code:

```js
window.__MOCHI_RUNTIME_CONFIG__ = {
  apiBaseUrl: 'https://app.example.com',
};
```

## Delivery plan

### 1. Web foundation

- Keep product features in shared React components.
- Route persistence, navigation, clipboard, dialogs, and notifications through
  the platform facade.
- Keep API calls behind `src/utils/api.js` and authentication behind
  `src/utils/authClient.js`.
- Test the web adapter and runtime API configuration.

### 2. Desktop proof of concept

- Create a Tauri 2 shell in a separate desktop package.
- Load the same built frontend and point it at the hosted Mochi API.
- Install a desktop adapter during bootstrap.
- Decide and test the desktop authentication transport early: cross-origin web
  cookies may be restricted by the webview, so browser OAuth may need to return
  through a deep link and store a scoped token in the operating-system keychain.
- Add native menus, window restoration, and deep links.

### 3. Local workspace features

- Add explicit adapter contracts for opening a directory, reading files, file
  watching, Git status/diffs, and approved process execution.
- Keep all native permissions scoped to a user-selected workspace.
- Show a diff before writes and an approval prompt before commands.
- Stream process output through typed events and support cancellation/timeouts.

### 4. Distribution

- macOS builds are ad-hoc signed; notarization needs an Apple Developer ID.
- Add crash reporting and privacy controls.
- Ship signed auto-updates with beta and stable channels.
- Add Windows signing and Linux packages after the workflow is stable.

## Definition of desktop-ready web features

A shared feature is ready when it does not import Tauri/Electron directly, does
not contain provider secrets, reaches server data through the API layer, and
uses the platform facade for an operating-system integration edge.
