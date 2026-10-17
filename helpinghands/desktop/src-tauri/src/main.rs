#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! RUSH Lab: a menu-bar app that runs its members' AI and plugins on this computer (lab.rs), opens
//! at every login, and connects a member when the site hands it their connect link
//! (rushlab://connect?site=&token=, server/routes/lab.js), once they confirm it is theirs.

mod lab;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use lab::Lab;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

// How long a launch waits, once running, for a connect link it was opened with before opening the site.
// What the login item opens RUSH Lab with: then it opens the site only while no member is connected.
const AT_LOGIN: &str = "--login";
const LINK_WAIT: Duration = Duration::from_secs(3);

/// Say `message` and quit: RUSH Lab cannot run.
fn fail(app: &AppHandle, message: String) -> ! {
    app.dialog().message(message).title("RUSH Lab").kind(MessageDialogKind::Error).blocking_show();
    std::process::exit(1);
}

/// RUSH Lab, once it is installed and running.
fn ready(app: &AppHandle) -> Arc<Lab> {
    loop {
        if let Some(lab) = app.try_state::<Arc<Lab>>() {
            return lab.inner().clone();
        }
        thread::sleep(Duration::from_millis(250));
    }
}

/// Connect the member `link` is for, once they confirm it: Ok(false) when they do not.
fn connect(app: &AppHandle, lab: &Lab, link: &Url) -> Result<bool, String> {
    if link.scheme() != "rushlab" || link.host_str() != Some("connect") {
        return Err(format!("RUSH Lab does not open {link}"));
    }
    let query = |name: &str| link.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).unwrap_or_default();
    let token = query("token");
    let answer: serde_json::Value = serde_json::from_str(&lab.ask(&["member", &query("site")], &token)?).map_err(|error| error.to_string())?;
    let (site, login) = (answer["site"].as_str().unwrap_or_default(), answer["member"]["login"].as_str().unwrap_or_default());
    let host = Url::parse(site).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
    let confirmed = app
        .dialog()
        .message(format!("Connect this computer to {host} as @{login}?\n\nThat account's AI and plugins will run here."))
        .title("RUSH Lab")
        .buttons(MessageDialogButtons::OkCancelCustom("Connect".into(), "Cancel".into()))
        .blocking_show();
    if !confirmed {
        return Ok(false);
    }
    lab.ask(&["connect", &lab.data.display().to_string(), site], &token)?;
    Ok(true)
}

fn main() {
    let linked = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AT_LOGIN])))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let open = MenuItem::with_id(app, "open", "Open RUSH Lab", true, None::<&str>)?;
            let logs = MenuItem::with_id(app, "logs", "Show Logs", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit RUSH Lab", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &logs, &PredefinedMenuItem::separator(app)?, &quit])?;
            let icon = app.default_window_icon().cloned().ok_or("the app has no icon")?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("RUSH Lab")
                .menu(&menu)
                .on_menu_event(|app, event| match (event.id().as_ref(), app.try_state::<Arc<Lab>>()) {
                    ("open", Some(lab)) => drop(app.opener().open_url(&lab.site_url, None::<&str>)),
                    ("logs", Some(lab)) => drop(app.opener().open_path(lab.data.join("logs").display().to_string(), None::<&str>)),
                    ("quit", _) => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let link_handle = app.handle().clone();
            let link_seen = linked.clone();
            app.deep_link().on_open_url(move |event| {
                link_seen.store(true, Ordering::SeqCst);
                for link in event.urls() {
                    let app = link_handle.clone();
                    thread::spawn(move || {
                        let lab = ready(&app);
                        if let Err(message) = connect(&app, &lab, &link) {
                            app.dialog().message(format!("This computer was not connected: {message}")).title("RUSH Lab").kind(MessageDialogKind::Error).blocking_show();
                        }
                    });
                }
            });

            // Off the main thread, where a dialog that waits for an answer cannot be shown.
            let handle = app.handle().clone();
            let first = linked.clone();
            thread::spawn(move || {
                // Opened from the disk image or Downloads, macOS runs it from a read-only copy that
                // moves, which nothing could open again at login.
                let exe = std::env::current_exe().unwrap_or_default();
                if exe.starts_with("/Volumes") || exe.to_string_lossy().contains("/AppTranslocation/") {
                    fail(&handle, "Drag RUSH Lab into your Applications folder, then open it from there.".into());
                }
                let lab = Arc::new(Lab::install(&handle).unwrap_or_else(|message| fail(&handle, format!("RUSH Lab could not be installed: {message}"))));
                if let Err(error) = handle.autolaunch().enable() {
                    fail(&handle, format!("RUSH Lab could not set itself to open at login: {error}"));
                }
                lab.start();
                handle.manage(lab.clone());
                // Opened by the member, it shows them RUSH Lab; at login, only a member not connected
                // yet needs the site, for the link that connects them. A link it was opened with is enough.
                let at_login = std::env::args().any(|arg| arg == AT_LOGIN);
                thread::sleep(LINK_WAIT);
                if !first.load(Ordering::SeqCst) && (!at_login || !lab.has_connections()) {
                    let _ = handle.opener().open_url(&lab.site_url, None::<&str>);
                }
            });

            // A signal (Ctrl+C on `npm run desktop`, kill) quits like the menu does, so lab.mjs is
            // stopped rather than left running.
            {
                use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
                let mut signals = signal_hook::iterator::Signals::new([SIGHUP, SIGINT, SIGTERM])?;
                let handle = app.handle().clone();
                thread::spawn(move || {
                    if signals.forever().next().is_some() {
                        handle.exit(0);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("RUSH Lab failed to start");
    app.run(|app, event| match event {
        // Opened again while it runs, it shows RUSH Lab: it has no window of its own.
        tauri::RunEvent::Reopen { .. } => {
            if let Some(lab) = app.try_state::<Arc<Lab>>() {
                let _ = app.opener().open_url(&lab.site_url, None::<&str>);
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(lab) = app.try_state::<Arc<Lab>>() {
                lab.stop();
            }
        }
        _ => {}
    });
}
