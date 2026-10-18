//! RUSH Lab keeps itself the build its site serves (GET /api/lab/updates/<target>,
//! server/routes/lab.js). Every CHECK_EVERY it asks for that build; one with a newer version (a
//! release's is its build's time, scripts/release.mjs) is downloaded, checked against the update
//! key (plugins.updater.pubkey in tauri.conf.json) and the version it was signed for, and installed
//! once nothing runs here and the app's windows are closed, a terminal's too, so an update never
//! stops a run, a page a member is on, or their shell. On macOS it is installed over this app,
//! which then opens it; on Windows its installer quits this app and opens the one it installed.
//! Only a release (npm run build:release) updates itself.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::UpdaterExt;

use crate::lab::Lab;

const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
const IDLE_POLL: Duration = Duration::from_secs(30);

/// Managed once an update is installed: quitting then opens it (main.rs).
pub struct Installed;

/// Keep this app the build `site` serves for `target`.
pub fn keep_updated(app: AppHandle, lab: Arc<Lab>, site: Url, target: String) {
    thread::spawn(move || loop {
        match tauri::async_runtime::block_on(install(&app, &lab, &site, &target)) {
            Ok(false) => {}
            Ok(true) => {
                lab.log("Opening the RUSH Lab installed.");
                app.manage(Installed);
                app.exit(0);
                return;
            }
            Err(message) => lab.log(&format!("RUSH Lab could not update itself: {message}")),
        }
        thread::sleep(CHECK_EVERY);
    });
}

/// Install the build `site` serves for `target` over this app, when it is another, once nothing
/// runs here: whether it did. On Windows it does not return, as the installer quits this app.
async fn install(app: &AppHandle, lab: &Arc<Lab>, site: &Url, target: &str) -> Result<bool, String> {
    let mut endpoint = site.clone();
    endpoint.set_path(&format!("/api/lab/updates/{target}"));
    let stopped = lab.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        // Windows' installer (quiet, tauri.conf.json) opens the build it installed, hidden as at login.
        .restart_after_install(false)
        .installer_args(["/R", "/ARGS", crate::AT_LOGIN])
        .on_before_exit(move || stopped.stop())
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    lab.log(&format!("Downloading RUSH Lab {}…", update.version));
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
    // Windows' installer quits this app, so it waits to install; macOS installs at once and waits to open it.
    #[cfg(windows)]
    wait_until_unused(app, lab);
    lab.log(&format!("Installing RUSH Lab {}…", update.version));
    update.install(bytes).map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    wait_until_unused(app, lab);
    Ok(true)
}

/// Until nothing runs here and the windows are closed.
fn wait_until_unused(app: &AppHandle, lab: &Lab) {
    while !(lab.idle() && window_closed(app)) {
        thread::sleep(IDLE_POLL);
    }
}

/// Whether the main window is hidden and no terminal window is open.
fn window_closed(app: &AppHandle) -> bool {
    !crate::terminal::running(app)
        && app.get_webview_window("main").is_none_or(|window| window.is_visible().is_ok_and(|visible| !visible))
}
