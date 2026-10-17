#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! RUSH Lab: the site in a window of its own, and its members' AI and plugins running on this
//! computer (lab.rs). It opens at every login, in the menu bar, and closing the window leaves it
//! running there. The window signs in through the member's browser (rushlab://sign-in). A member
//! signed in in the window is connected as soon as the site hands the window their connect link
//! (rushlab://connect?site=&token=, server/routes/lab.js); a link from anywhere else connects them
//! only once they confirm it is theirs.

mod lab;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use lab::Lab;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

// What the login item opens RUSH Lab with: then its window starts hidden.
const AT_LOGIN: &str = "--login";
// Tells the site's pages they are in the app's window (src/theme/Root/LabScreen.js).
const IN_APP: &str = "window.__RUSH_LAB_APP__ = true;";

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

/// The window, shown and in front, with RUSH Lab in the Dock while it is.
fn show(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Connect the member `link` is for: at once when the window's own site handed it over, as they
/// are signed in there; otherwise once they confirm it. Ok(false) when they do not.
fn connect(app: &AppHandle, lab: &Lab, link: &Url, from_window: bool) -> Result<bool, String> {
    if link.scheme() != "rushlab" || link.host_str() != Some("connect") {
        return Err(format!("RUSH Lab does not open {link}"));
    }
    let query = |name: &str| link.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).unwrap_or_default();
    let token = query("token");
    let answer: serde_json::Value = serde_json::from_str(&lab.ask(&["member", &query("site")], &token)?).map_err(|error| error.to_string())?;
    let (site, login) = (answer["site"].as_str().unwrap_or_default(), answer["member"]["login"].as_str().unwrap_or_default());
    let site_url = Url::parse(site).map_err(|error| error.to_string())?;
    let window_site = app.get_webview_window("main").and_then(|window| window.url().ok()).map(|url| url.origin());
    if !(from_window && window_site == Some(site_url.origin())) {
        let host = site_url.host_str().unwrap_or_default();
        let confirmed = app
            .dialog()
            .message(format!("Connect this computer to {host} as @{login}?\n\nThat account's AI and plugins will run here."))
            .title("RUSH Lab")
            .buttons(MessageDialogButtons::OkCancelCustom("Connect".into(), "Cancel".into()))
            .blocking_show();
        if !confirmed {
            return Ok(false);
        }
    }
    lab.ask(&["connect", &lab.data.display().to_string(), site], &token)?;
    Ok(true)
}

/// The sign-in the window asked for in the browser (rushlab://sign-in from the window), named by
/// its random state: the only one the app takes back.
struct SignIn(Mutex<Option<String>>);

/// Sign the window in through the member's browser, where GitHub's passkeys and their own
/// sign-in work (GET /api/lab/sign-in, server/routes/lab.js).
fn sign_in_in_browser(app: &AppHandle) -> Result<(), String> {
    let mut bytes = [0u8; 24];
    std::fs::File::open("/dev/urandom").and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes)).map_err(|error| error.to_string())?;
    let state: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    *app.state::<SignIn>().0.lock().unwrap() = Some(state.clone());
    let mut page = Url::parse(&lab::site_url(app)?).map_err(|error| error.to_string())?;
    page.set_path("/api/lab/sign-in");
    page.query_pairs_mut().append_pair("state", &state);
    app.opener().open_url(page.as_str(), None::<&str>).map_err(|error| error.to_string())
}

/// The browser's answer (rushlab://sign-in?state=&token=): the window signs in with it, if it is
/// the sign-in the window asked for, and only once.
fn signed_in(app: &AppHandle, link: &Url) -> Result<(), String> {
    let query = |name: &str| link.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).unwrap_or_default();
    let asked = app.state::<SignIn>().0.lock().unwrap().take();
    if asked.is_none() || asked != Some(query("state")) {
        return Err("RUSH Lab did not ask for this sign-in. Sign in from its window.".into());
    }
    let mut page = Url::parse(&lab::site_url(app)?).map_err(|error| error.to_string())?;
    page.set_path("/api/lab/window-sign-in");
    page.query_pairs_mut().append_pair("token", &query("token"));
    let window = app.get_webview_window("main").ok_or("RUSH Lab has no window")?;
    window.navigate(page).map_err(|error| error.to_string())?;
    show(app);
    Ok(())
}

/// Say why `link` was not followed.
fn refuse(app: &AppHandle, message: String) {
    let app = app.clone();
    thread::spawn(move || {
        app.dialog().message(message).title("RUSH Lab").kind(MessageDialogKind::Error).blocking_show();
    });
}

/// Connect `link`'s member off the main thread, where a dialog that waits for an answer cannot be shown.
fn connect_later(app: &AppHandle, link: Url, from_window: bool) {
    let app = app.clone();
    thread::spawn(move || {
        let lab = ready(&app);
        if let Err(message) = connect(&app, &lab, &link, from_window) {
            app.dialog().message(format!("This computer was not connected: {message}")).title("RUSH Lab").kind(MessageDialogKind::Error).blocking_show();
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AT_LOGIN])))
        .manage(SignIn(Mutex::new(None)))
        .setup(|app| {
            let at_login = std::env::args().any(|arg| arg == AT_LOGIN);
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if at_login { tauri::ActivationPolicy::Accessory } else { tauri::ActivationPolicy::Regular });
            let site: Url = lab::site_url(app.handle())?.parse()?;
            let handle = app.handle().clone();
            let opener = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(site))
                .title("RUSH Lab")
                .inner_size(1280.0, 832.0)
                .min_inner_size(800.0, 600.0)
                .visible(!at_login)
                .initialization_script(IN_APP)
                // The site's rushlab: links are the app's to follow, not the page's.
                .on_navigation(move |url| {
                    if url.scheme() != "rushlab" {
                        return true;
                    }
                    if url.host_str() == Some("sign-in") {
                        if let Err(message) = sign_in_in_browser(&handle) {
                            refuse(&handle, format!("RUSH Lab could not open your browser to sign in: {message}"));
                        }
                    } else {
                        connect_later(&handle, url.clone(), true);
                    }
                    false
                })
                // Links that ask for a new window open in the system browser.
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            // Closing the window leaves RUSH Lab running in the menu bar, so runs still reach this computer.
            let hidden = app.handle().clone();
            let closing = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = closing.hide();
                    #[cfg(target_os = "macos")]
                    let _ = hidden.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            });

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
                    ("open", _) => show(app),
                    ("logs", Some(lab)) => drop(app.opener().open_path(lab.data.join("logs").display().to_string(), None::<&str>)),
                    ("quit", _) => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for link in event.urls() {
                    if link.host_str() == Some("sign-in") {
                        if let Err(message) = signed_in(&link_handle, &link) {
                            refuse(&link_handle, format!("RUSH Lab was not signed in: {message}"));
                        }
                    } else {
                        connect_later(&link_handle, link, false);
                    }
                }
            });

            // Off the main thread, where a dialog that waits for an answer cannot be shown.
            let handle = app.handle().clone();
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
                handle.manage(lab);
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
        // The Dock icon, or opening the app again, brings the window back.
        tauri::RunEvent::Reopen { .. } => show(app),
        tauri::RunEvent::Exit => {
            if let Some(lab) = app.try_state::<Arc<Lab>>() {
                lab.stop();
            }
        }
        _ => {}
    });
}
