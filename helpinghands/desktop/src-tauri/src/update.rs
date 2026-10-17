//! RUSH Lab keeps itself the build its site serves (GET /api/lab/updates/<target>,
//! server/routes/lab.js). Every CHECK_EVERY it asks for that build; one with a newer version (a
//! release's is its build's time, scripts/release.mjs) is downloaded, checked against the update
//! key (plugins.updater.pubkey in tauri.conf.json) and the version it was signed for, and installed
//! over this app. The app opens it once nothing runs here and its window is closed, so an update
//! never stops a run or a page a member is on. Only a release (npm run build:release) updates itself.

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
                while !(lab.idle() && window_closed(&app)) {
                    thread::sleep(IDLE_POLL);
                }
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

/// Install the build `site` serves for `target` over this app, when it is another: whether it did.
async fn install(app: &AppHandle, lab: &Lab, site: &Url, target: &str) -> Result<bool, String> {
    let mut endpoint = site.clone();
    endpoint.set_path(&format!("/api/lab/updates/{target}"));
    let updater = app.updater_builder().endpoints(vec![endpoint]).map_err(|error| error.to_string())?.build().map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    lab.log(&format!("Installing RUSH Lab {}…", update.version));
    update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
    Ok(true)
}

fn window_closed(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_none_or(|window| window.is_visible().is_ok_and(|visible| !visible))
}
