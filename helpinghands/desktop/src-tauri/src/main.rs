#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! RUSH Lab: the site in a window of its own, and its members' AI and plugins running on this
//! computer (lab.rs). It opens at every login, in the menu bar, and closing the window leaves it
//! running there. The window signs in in macOS's sign-in sheet over it (sign_in.rs). A member
//! signed in in the window is connected as soon as the site hands the window their connect link
//! (<scheme>://connect?site=&token=, server/routes/lab.js); a link from anywhere else connects them
//! only once they confirm it is theirs. Its window is always its own site's, config.json's site_url:
//! rush-lab.org's for RUSH Lab, and for RUSH Lab Dev (`npm run desktop:dev`) this checkout's local
//! site; the two differ only in config.json (lab.rs). A release keeps itself the build its site
//! serves (update.rs). Its terminal windows run the member's own shell on a page the app bundles
//! (terminal.rs), opened from the menu bar or by <scheme>://terminal. The scheme is config.json's:
//! rushlab for RUSH Lab, rushlab-dev for RUSH Lab Dev.

mod lab;
mod setup;
#[cfg(target_os = "macos")]
mod sign_in;
mod terminal;
mod update;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use lab::Lab;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

// What the login item opens RUSH Lab with, and an update the build it installed: then its window starts hidden.
const AT_LOGIN: &str = "--login";
// Tells the site's pages they are in the app's window (src/utils/labApp.js), that it opens
// <scheme>://terminal, and on macOS that the app signs the window in (sign_in.rs): WebKit gives
// GitHub's passkeys only to an app signed by an Apple developer. WebView2 gives them through Windows
// Hello, so there the window signs in as the site does.
#[cfg(target_os = "macos")]
const IN_APP: &str = "window.__RUSH_LAB_APP__ = true; window.__RUSH_LAB_TERMINAL__ = true; window.__RUSH_LAB_SIGNS_IN__ = true;";
#[cfg(not(target_os = "macos"))]
const IN_APP: &str = "window.__RUSH_LAB_APP__ = true; window.__RUSH_LAB_TERMINAL__ = true;";

/// This build's config.json (lab.rs), which the app keeps from its start.
fn app_config(app: &AppHandle) -> tauri::State<'_, lab::Config> {
    app.state::<lab::Config>()
}

/// Say `message` and quit: the app cannot run.
fn fail(app: &AppHandle, message: String) -> ! {
    app.dialog().message(message).title(&app_config(app).product_name).kind(MessageDialogKind::Error).blocking_show();
    std::process::exit(1);
}

/// The site the window shows and signs in to.
#[cfg(target_os = "macos")]
struct Site(Url);

/// The app, once it is installed and running.
fn ready(app: &AppHandle) -> Arc<Lab> {
    loop {
        if let Some(lab) = app.try_state::<Arc<Lab>>() {
            return lab.inner().clone();
        }
        thread::sleep(Duration::from_millis(250));
    }
}

/// The window, shown and in front, with the app in the Dock while it is.
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
    let config = app_config(app);
    if link.scheme() != config.scheme || link.host_str() != Some("connect") {
        return Err(format!("{} does not open {link}", config.product_name));
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
            .title(&config.product_name)
            .buttons(MessageDialogButtons::OkCancelCustom("Connect".into(), "Cancel".into()))
            .blocking_show();
        if !confirmed {
            return Ok(false);
        }
    }
    lab.ask(&["connect", &lab.data.display().to_string(), site], &token)?;
    Ok(true)
}

/// Sign the window in, in the sign-in sheet over it: the site's sign-in for the app
/// (GET /api/lab/sign-in, server/routes/lab.js) ends it with <scheme>://sign-in?state=&token=, which
/// signs the window in if it is this sign-in's.
#[cfg(target_os = "macos")]
fn sign_in(app: &AppHandle) -> Result<(), String> {
    let mut bytes = [0u8; 24];
    std::fs::File::open("/dev/urandom").and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes)).map_err(|error| error.to_string())?;
    let state: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut page = app.state::<Site>().0.clone();
    page.set_path("/api/lab/sign-in");
    page.query_pairs_mut().append_pair("state", &state);
    let config = app_config(app);
    let window = app.get_webview_window("main").ok_or(format!("{} has no window", config.product_name))?;
    let handle = app.clone();
    sign_in::show(&window, page, &config.scheme, move |answer| {
        let signed = answer.and_then(|link| match link {
            Some(link) => signed_in(&handle, &link, &state),
            None => Ok(()),
        });
        if let Err(message) = signed {
            refuse(&handle, format!("{} was not signed in: {message}", app_config(&handle).product_name));
        }
    })
}

/// The site's answer to the sign-in `state` named (<scheme>://sign-in?state=&token=): the window
/// signs in with its token.
#[cfg(target_os = "macos")]
fn signed_in(app: &AppHandle, link: &Url, state: &str) -> Result<(), String> {
    let query = |name: &str| link.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).unwrap_or_default();
    let config = app_config(app);
    if link.scheme() != config.scheme || link.host_str() != Some("sign-in") || query("state") != state {
        return Err(format!("the site answered {link}, which is not this sign-in's"));
    }
    let mut page = app.state::<Site>().0.clone();
    page.set_path("/api/lab/window-sign-in");
    page.query_pairs_mut().append_pair("token", &query("token"));
    let window = app.get_webview_window("main").ok_or(format!("{} has no window", config.product_name))?;
    window.navigate(page).map_err(|error| error.to_string())?;
    show(app);
    Ok(())
}

/// Say why the sign-in did not sign the window in.
#[cfg(target_os = "macos")]
fn refuse(app: &AppHandle, message: String) {
    let app = app.clone();
    thread::spawn(move || {
        app.dialog().message(message).title(&app_config(&app).product_name).kind(MessageDialogKind::Error).blocking_show();
    });
}

/// Whether `link` is <scheme>://terminal, which opens a terminal window and runs nothing.
fn is_terminal(link: &Url, scheme: &str) -> bool {
    link.scheme() == scheme && link.host_str() == Some("terminal")
}

/// Open a terminal window on the projects folder, or say why it did not open.
fn open_terminal(app: &AppHandle) {
    if let Err(message) = terminal::open_window(app, None) {
        app.dialog().message(format!("The terminal did not open: {message}")).title(&app_config(app).product_name).kind(MessageDialogKind::Error).show(|_| {});
    }
}

/// Connect `link`'s member off the main thread, where a dialog that waits for an answer cannot be shown.
fn connect_later(app: &AppHandle, link: Url, from_window: bool) {
    let app = app.clone();
    thread::spawn(move || {
        let lab = ready(&app);
        if let Err(message) = connect(&app, &lab, &link, from_window) {
            app.dialog().message(format!("This computer was not connected: {message}")).title(&app_config(&app).product_name).kind(MessageDialogKind::Error).blocking_show();
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(terminal::Terminals::default())
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_projects,
            terminal::terminal_new_project,
            terminal::terminal_open_project,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
        ])
        .setup(|app| {
            let at_login = std::env::args().any(|arg| arg == AT_LOGIN);
            #[cfg(target_os = "macos")]
            app.set_activation_policy(if at_login { tauri::ActivationPolicy::Accessory } else { tauri::ActivationPolicy::Regular });
            let config = lab::config(app.handle())?;
            let site: Url = config.site_url.parse()?;
            let (name, scheme, update_target) = (config.product_name.clone(), config.scheme.clone(), config.update_target.clone());
            app.manage(config);
            #[cfg(target_os = "macos")]
            app.manage(Site(site.clone()));
            app.manage(setup::Setup::new());
            let update_site = site.clone();
            let handle = app.handle().clone();
            let opener = app.handle().clone();
            let navigation_scheme = scheme.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(site))
                .title(&name)
                .inner_size(1280.0, 832.0)
                .min_inner_size(800.0, 600.0)
                .visible(!at_login)
                .initialization_script(IN_APP)
                // Each page is told what setting up is doing (setup.rs), as the one before it was.
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        setup::again(&window);
                    }
                })
                // The site's <scheme>: links are the app's to follow, not the page's.
                .on_navigation(move |url| {
                    if url.scheme() != navigation_scheme {
                        return true;
                    }
                    #[cfg(target_os = "macos")]
                    if url.host_str() == Some("sign-in") {
                        // The sheet opens on the main thread, once this navigation is refused.
                        let signing = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            if let Err(message) = sign_in(&signing) {
                                refuse(&signing, format!("{} could not open its sign-in: {message}", app_config(&signing).product_name));
                            }
                        });
                        return false;
                    }
                    if is_terminal(url, &navigation_scheme) {
                        // The window opens on the main thread, once this navigation is refused.
                        let opening = handle.clone();
                        let _ = handle.run_on_main_thread(move || open_terminal(&opening));
                        return false;
                    }
                    connect_later(&handle, url.clone(), true);
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
            // Closing the window leaves the app running in the menu bar, so runs still reach this computer.
            let hidden = app.handle().clone();
            let closing = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = closing.hide();
                    // In the Dock still while a terminal window is open.
                    #[cfg(target_os = "macos")]
                    if !terminal::running(&hidden) {
                        let _ = hidden.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                }
            });

            let open = MenuItem::with_id(app, "open", format!("Open {name}"), true, None::<&str>)?;
            let new_terminal = MenuItem::with_id(app, "terminal", "New Terminal", true, None::<&str>)?;
            let logs = MenuItem::with_id(app, "logs", "Show Logs", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", format!("Quit {name}"), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &new_terminal, &logs, &PredefinedMenuItem::separator(app)?, &quit])?;
            let icon = app.default_window_icon().cloned().ok_or("the app has no icon")?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip(&name)
                .menu(&menu)
                .on_menu_event(|app, event| match (event.id().as_ref(), app.try_state::<Arc<Lab>>()) {
                    ("open", _) => show(app),
                    ("terminal", _) => open_terminal(app),
                    ("logs", Some(lab)) => drop(app.opener().open_path(lab.data.join("logs").display().to_string(), None::<&str>)),
                    ("quit", _) => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for link in event.urls() {
                    if is_terminal(&link, &scheme) {
                        // From another thread: this runs on the main thread while the event's listeners
                        // are locked, and building a window there waits for that lock.
                        let opening = link_handle.clone();
                        thread::spawn(move || open_terminal(&opening));
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
                    fail(&handle, format!("Drag {name} into your Applications folder, then open it from there."));
                }
                setup::installing(&handle);
                let lab = Arc::new(Lab::install(&handle).unwrap_or_else(|message| fail(&handle, format!("{name} could not be installed: {message}"))));
                if let Err(error) = handle.autolaunch().enable() {
                    fail(&handle, format!("{name} could not set itself to open at login: {error}"));
                }
                // What the last run said of setting up is not this one's.
                let _ = std::fs::remove_file(lab.data.join(setup::FILE));
                setup::follow(handle.clone(), lab.data.clone());
                lab.start();
                if let Some(target) = update_target {
                    update::keep_updated(handle.clone(), lab.clone(), update_site, target);
                }
                handle.manage(lab);
            });

            // A signal (Ctrl+C on `npm run desktop`, kill) quits like the menu does, so lab.mjs is
            // stopped rather than left running.
            #[cfg(unix)]
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
        .expect("the app failed to start");
    app.run(|app, event| match event {
        // The Dock icon, or opening the app again, brings the window back.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show(app),
        tauri::RunEvent::Exit => {
            terminal::close_all(app);
            if let Some(lab) = app.try_state::<Arc<Lab>>() {
                lab.stop();
            }
            // An update opens the build it installed, on the same site, its window hidden as this one's was.
            if app.try_state::<update::Installed>().is_some() {
                let mut env = app.env();
                env.args_os.retain(|arg| arg != AT_LOGIN);
                env.args_os.insert(1, AT_LOGIN.into());
                app.cleanup_before_exit();
                tauri::process::restart(&env);
            }
        }
        _ => {}
    });
}
