//! What RUSH Lab is doing to set this computer up, told to its window, whose setup screen shows it
//! (src/theme/Root/LabScreen.js, useLabSetup in src/utils/labApp.js): `{stage, error}`.
//!
//! The app is at `install` while it installs this build (Lab::install); from then on lab.mjs says,
//! in the data folder's setup.json, as it prepares Python, starts NanoAgent and connects. The window
//! keeps the latest in `window.__RUSH_LAB_SETUP__` and hears each change as the event `rushlab:setup`;
//! each page it loads is told the latest again.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

/// How often setup.json is read.
const POLL: Duration = Duration::from_millis(300);
/// What lab.mjs writes (src/runner/lab.mjs).
pub const FILE: &str = "setup.json";

/// The latest the window was told, as JSON.
pub struct Setup(Mutex<Option<String>>);

impl Setup {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

/// The script that hands `json` to the page.
fn script(json: &str) -> String {
    format!("window.__RUSH_LAB_SETUP__ = {json}; window.dispatchEvent(new CustomEvent('rushlab:setup', {{detail: window.__RUSH_LAB_SETUP__}}));")
}

/// Keep `value` as the latest and tell the window.
fn tell(app: &AppHandle, value: serde_json::Value) {
    let json = value.to_string();
    *app.state::<Setup>().0.lock().unwrap() = Some(json.clone());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script(&json));
    }
}

/// The app is installing this build.
pub fn installing(app: &AppHandle) {
    tell(app, serde_json::json!({"stage": "install", "error": null}));
}

/// Tell a page the window has just loaded the latest, if there is one.
pub fn again(window: &WebviewWindow) {
    if let Some(json) = window.app_handle().state::<Setup>().0.lock().unwrap().clone() {
        let _ = window.eval(script(&json));
    }
}

/// Tell the window each change lab.mjs makes to `data`'s setup.json, from now on. A file it is
/// writing may not read whole yet; it is read again next time.
pub fn follow(app: AppHandle, data: PathBuf) {
    thread::spawn(move || {
        let mut last = String::new();
        loop {
            if let Ok(text) = fs::read_to_string(data.join(FILE)) {
                if text != last {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                        tell(&app, value);
                        last = text;
                    }
                }
            }
            thread::sleep(POLL);
        }
    });
}
