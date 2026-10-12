#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod supervisor;

use std::sync::Arc;

use supervisor::{Status, Supervisor};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn status(supervisor: State<Arc<Supervisor>>) -> Status {
    supervisor.status()
}

#[tauri::command]
fn retry(app: AppHandle, supervisor: State<Arc<Supervisor>>) -> Result<(), String> {
    supervisor.restart(app)
}

#[tauri::command]
fn save_settings(app: AppHandle, supervisor: State<Arc<Supervisor>>, contents: String) -> Result<(), String> {
    supervisor.save_settings(app, &contents)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![status, retry, save_settings])
        .setup(|app| {
            let supervisor = Arc::new(Supervisor::new(app.handle())?);
            let origin = supervisor.config.origin();
            // The site resolves its API from this (src/utils/api.js); on any other page it is not set.
            let runtime_config = format!(
                "if (location.origin === {origin:?}) window.__MOCHI_RUNTIME_CONFIG__ = {{apiBaseUrl: location.origin}};"
            );
            let opener = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mochi Lab")
                .inner_size(1280.0, 832.0)
                .min_inner_size(800.0, 600.0)
                .initialization_script(runtime_config)
                // Links that ask for a new window open in the system browser.
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            supervisor.start(app.handle().clone());
            app.manage(supervisor);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Mochi Lab failed to build its window");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(supervisor) = app.try_state::<Arc<Supervisor>>() {
                supervisor.stop();
            }
        }
    });
}
