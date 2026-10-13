#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod supervisor;

use std::collections::BTreeMap;
use std::sync::Arc;

use supervisor::{KeyStatus, Status, Supervisor};
use tauri::menu::{Menu, MenuItem, MenuItemKind};
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

// The keys page's commands: only the app's own pages may call them, never the site it shows.
#[tauri::command]
fn keys(supervisor: State<Arc<Supervisor>>) -> Vec<KeyStatus> {
    supervisor.keys()
}

#[tauri::command]
fn save_keys(supervisor: State<Arc<Supervisor>>, changes: BTreeMap<String, Option<String>>) -> Result<(), String> {
    supervisor.save_keys(changes)
}

#[tauri::command]
fn open_site(app: AppHandle, supervisor: State<Arc<Supervisor>>) -> Result<(), String> {
    supervisor.open_site(&app)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![status, retry, keys, save_keys, open_site])
        // The platform's menu, with API Keys… after About on macOS.
        .menu(|handle| {
            let menu = Menu::default(handle)?;
            let keys = MenuItem::with_id(handle, "keys", "API Keys…", true, Some("CmdOrCtrl+,"))?;
            if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
                first.insert(&keys, 1)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "keys" {
                if let Some(supervisor) = app.try_state::<Arc<Supervisor>>() {
                    supervisor.show(app, "keys.html");
                }
            }
        })
        .setup(|app| {
            let supervisor = Arc::new(Supervisor::new(app.handle())?);
            let opener = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mochi Lab")
                .inner_size(1280.0, 832.0)
                .min_inner_size(800.0, 600.0)
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
            // A signal (Ctrl+C on `npm run desktop`, kill) quits like the menu does, so the
            // services are stopped rather than left running.
            #[cfg(unix)]
            {
                use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
                let mut signals = signal_hook::iterator::Signals::new([SIGHUP, SIGINT, SIGTERM])?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if signals.forever().next().is_some() {
                        handle.exit(0);
                    }
                });
            }
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
