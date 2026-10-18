//! RUSH Lab's terminal: windows of their own, labelled terminal-<n>, each on the page the app
//! bundles (desktop/terminal/), never the site, running the member's login shell in a PTY. A login
//! shell reads the member's profile, so its PATH finds their AI CLIs (claude, codex, gemini, ...);
//! first on it, put back there once the profile has run, are launchers for the installed build's
//! NanoAgent, uv and `rushlab` (lab.mjs): a command, named rushlab in RUSH Lab Dev too, not the
//! app's link scheme (config.json's). The PTY's bytes go only between this file and the window's
//! page, never through Mochi or the relay.
//!
//! A window opens on the projects folder (~/<projects_folder>/) or on one plugin project in it,
//! which New plugin… makes with `nanoagent plugin new` and the publish-plugin skill written in as
//! AGENTS.md, CLAUDE.md and GEMINI.md, so each AI CLI reads it on its own. Only the bundled page
//! reaches these commands (capabilities/terminal.json names the terminal windows, and no remote
//! page), and each refuses any other window and another window's shell. Closing a window ends its
//! shell; quitting RUSH Lab ends every one.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::lab::{self, Lab};

const LABEL: &str = "terminal-";
const CHUNK: usize = 64 * 1024;
// What New plugin… writes into a project, each the whole text, so each AI CLI reads its own.
const SKILL_FILES: [&str; 3] = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

/// The terminal windows open, by label with the folder each starts in, and their shells, by id.
#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    windows: Mutex<HashMap<String, PathBuf>>,
    sessions: Mutex<HashMap<u32, Session>>,
}

struct Session {
    window: String,
    /// What is typed, for the thread writing it into the PTY, which blocks while the shell reads nothing.
    typed: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    /// The shell's process group, its own id (portable-pty starts it as a session leader).
    #[cfg(unix)]
    pid: u32,
    /// What kills the shell, which the thread waiting for it holds.
    #[cfg(windows)]
    child: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

#[derive(Serialize)]
pub struct Project {
    id: String,
    folder: PathBuf,
}

/// RUSH Lab, once it has installed its build.
fn installed(app: &AppHandle) -> Result<Arc<Lab>, String> {
    app.try_state::<Arc<Lab>>().map(|lab| lab.inner().clone()).ok_or_else(|| format!("{} is still installing", app.state::<lab::Config>().product_name))
}

/// RUSH Lab and the terminal window `webview` is, refusing any other window.
fn terminal_window(webview: &Webview) -> Result<(Arc<Lab>, String), String> {
    let label = webview.label();
    if !label.starts_with(LABEL) {
        return Err(format!("{label} is not a terminal window"));
    }
    Ok((installed(webview.app_handle())?, label.to_string()))
}

/// A plugin id, as `nanoagent plugin new` takes it: ^[a-z0-9]+(-[a-z0-9]+)*$.
fn check_id(id: &str) -> Result<(), String> {
    let lower = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if id.split('-').all(lower) {
        Ok(())
    } else {
        Err(format!("{id:?} is not a plugin id: lowercase letters and numbers, in words joined by single hyphens"))
    }
}

/// Refuse `folder` unless it is the projects folder or inside it, through no `..` or link out.
/// Only this check sees the canonical paths: on Windows they are verbatim (\\?\C:\...), which no
/// shell starts in.
fn inside(projects: &Path, folder: &Path) -> Result<(), String> {
    let root = projects.canonicalize().map_err(|error| format!("{}: {error}", projects.display()))?;
    let canonical = folder.canonicalize().map_err(|error| format!("{}: {error}", folder.display()))?;
    if !canonical.starts_with(&root) {
        return Err(format!("{} is not in {}", folder.display(), projects.display()));
    }
    Ok(())
}

/// The projects folder, made when it is not there yet.
fn projects_folder(app: &AppHandle) -> Result<PathBuf, String> {
    let projects = lab::projects_folder(app)?;
    fs::create_dir_all(&projects).map_err(|error| format!("{}: {error}", projects.display()))?;
    Ok(projects)
}

/// `path` as one word of sh, in single quotes: Application Support has a space.
#[cfg(unix)]
fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// What a launcher says when the build it runs is not set up yet, in the app `name`.
fn missing(name: &str) -> String {
    format!("{name} is still setting up NanoAgent (menu bar → Show Logs)")
}

/// The launchers for the build installed at `root` by the app `name`: each file's name and text.
#[cfg(unix)]
fn launchers(root: &Path, name: &str) -> Vec<(String, String)> {
    let bin = root.join("bin");
    let missing = missing(name);
    let script = |targets: &[PathBuf], run: String| {
        let checks: String = targets.iter().map(|target| format!("[ -e {} ] || missing\n", quote(target))).collect();
        format!("#!/bin/sh\n# Written by RUSH Lab for the build it runs (src-tauri/src/terminal.rs).\nmissing() {{ echo '{missing}' >&2; exit 1; }}\n{checks}{run}\n")
    };
    let python = root.join("nanoagent/.venv/bin/python");
    let (node, lab_mjs) = (bin.join("node"), root.join("runner/lab.mjs"));
    vec![
        ("nanoagent".into(), script(&[python.clone()], format!("PATH={}:\"$PATH\" exec {} -I -m nanoagent \"$@\"", quote(&bin), quote(&python)))),
        ("uv".into(), script(&[bin.join("uv")], format!("exec {} \"$@\"", quote(&bin.join("uv"))))),
        ("rushlab".into(), script(&[node.clone(), lab_mjs.clone()], format!("exec {} {} rushlab \"$@\"", quote(&node), quote(&lab_mjs)))),
    ]
}

/// The launchers for the build installed at `root` by the app `name`: each file's name and text.
#[cfg(windows)]
fn launchers(root: &Path, name: &str) -> Vec<(String, String)> {
    let bin = root.join("bin");
    let missing = missing(name);
    let script = |targets: &[PathBuf], run: String| {
        let checks: String = targets.iter().map(|target| format!("if not exist \"{}\" goto missing\r\n", target.display())).collect();
        format!("@echo off\r\nrem Written by RUSH Lab for the build it runs (src-tauri/src/terminal.rs).\r\nsetlocal\r\n{checks}{run}\r\nexit /b %errorlevel%\r\n:missing\r\necho {missing} 1>&2\r\nexit /b 1\r\n")
    };
    let python = root.join(r"nanoagent\.venv\Scripts\python.exe");
    let (node, uv, lab_mjs) = (bin.join("node.exe"), bin.join("uv.exe"), root.join(r"runner\lab.mjs"));
    vec![
        ("nanoagent.cmd".into(), script(&[python.clone()], format!("set \"PATH={};%PATH%\"\r\n\"{}\" -I -m nanoagent %*", bin.display(), python.display()))),
        ("uv.cmd".into(), script(&[uv.clone()], format!("\"{}\" %*", uv.display()))),
        ("rushlab.cmd".into(), script(&[node.clone(), lab_mjs.clone()], format!("\"{}\" \"{}\" rushlab %*", node.display(), lab_mjs.display()))),
    ]
}

/// What zsh and bash read in place of a login shell's files: the member's own, then RUSH_LAB_BIN
/// first on PATH. Their profile cannot have the last word, as macOS's /etc/zprofile and
/// /etc/profile rebuild PATH (path_helper) and the member's own files prepend more. zsh reads its
/// files from ZDOTDIR, this folder, which each puts back after reading the member's of that name
/// from RUSH_LAB_ZDOTDIR, as their .zshenv may move it; .zlogin is the last a login zsh reads.
/// bash's --rcfile reads what a login bash reads.
#[cfg(unix)]
fn startup_files() -> Vec<(&'static str, String)> {
    let zsh = |name: &str| format!("ZDOTDIR=$RUSH_LAB_ZDOTDIR\n[[ -f \"$ZDOTDIR/{name}\" ]] && source \"$ZDOTDIR/{name}\"\n");
    let back = "RUSH_LAB_ZDOTDIR=$ZDOTDIR\nZDOTDIR=$RUSH_LAB_SHELL\n";
    let first = "export PATH=\"$RUSH_LAB_BIN:$PATH\"\n";
    vec![
        (".zshenv", format!("{}{back}", zsh(".zshenv"))),
        (".zprofile", format!("{}{back}", zsh(".zprofile"))),
        (".zshrc", format!("{}{back}", zsh(".zshrc"))),
        (".zlogin", format!("{}{first}unset RUSH_LAB_ZDOTDIR RUSH_LAB_SHELL RUSH_LAB_BIN\n", zsh(".zlogin"))),
        (
            "bashrc",
            format!(
                "[ -r /etc/profile ] && . /etc/profile\nfor rush_lab_profile in ~/.bash_profile ~/.bash_login ~/.profile; do\n  [ -r \"$rush_lab_profile\" ] && {{ . \"$rush_lab_profile\"; break; }}\ndone\nunset rush_lab_profile\n{first}unset RUSH_LAB_BIN\n"
            ),
        ),
    ]
}

/// Write `text` to `file` whole, through a `.partial` beside it, as a shell may be reading it.
fn write_whole(file: &Path, text: &str, executable: bool) -> Result<(), String> {
    let partial = file.with_file_name(format!("{}.partial", file.file_name().unwrap_or_default().to_string_lossy()));
    fs::write(&partial, text).map_err(|error| format!("{}: {error}", partial.display()))?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&partial, fs::Permissions::from_mode(0o755)).map_err(|error| format!("{}: {error}", partial.display()))?;
    }
    #[cfg(windows)]
    let _ = executable;
    fs::rename(&partial, file).map_err(|error| format!("{}: {error}", file.display()))
}

/// <data>/terminal/, rewritten for the build installed now: bin/ its launchers, and on unix shell/
/// the shells' startup files. The launchers' folder.
fn write_launchers(app: &AppHandle, lab: &Lab) -> Result<PathBuf, String> {
    let terminal = lab.data.join("terminal");
    let bin = terminal.join("bin");
    fs::create_dir_all(&bin).map_err(|error| format!("{}: {error}", bin.display()))?;
    for (name, text) in launchers(lab.root(), &app.state::<lab::Config>().product_name) {
        write_whole(&bin.join(name), &text, true)?;
    }
    #[cfg(unix)]
    write_startup(&terminal)?;
    Ok(bin)
}

/// <terminal>/shell/, the shells' startup files (startup_files).
#[cfg(unix)]
fn write_startup(terminal: &Path) -> Result<(), String> {
    let startup = terminal.join("shell");
    fs::create_dir_all(&startup).map_err(|error| format!("{}: {error}", startup.display()))?;
    for (name, text) in startup_files() {
        write_whole(&startup.join(name), &format!("# Written by RUSH Lab (src-tauri/src/terminal.rs).\n{text}"), false)?;
    }
    Ok(())
}

/// What a new project's AGENTS.md, CLAUDE.md and GEMINI.md hold: the preface (desktop/terminal/project.md)
/// for the plugin `id`, then the whole skill.
fn skill_text(preface: &str, skill: &str, id: &str) -> String {
    format!("{}\n{skill}", preface.replace("{{id}}", id))
}

/// Open a terminal window on `folder`, a project, or else on the projects folder.
pub fn open_window(app: &AppHandle, folder: Option<PathBuf>) -> Result<(), String> {
    let lab = installed(app)?;
    let projects = projects_folder(app)?;
    let name = &app.state::<lab::Config>().product_name;
    let title = match &folder {
        Some(folder) => format!("{} — {name}", folder.file_name().unwrap_or_default().to_string_lossy()),
        None => format!("Terminal — {name}"),
    };
    let folder = folder.unwrap_or(projects.clone());
    inside(&projects, &folder)?;
    write_launchers(app, &lab)?;
    let terminals = app.state::<Terminals>();
    let label = format!("{LABEL}{}", terminals.next.fetch_add(1, Ordering::SeqCst));
    let opener = app.clone();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("terminal/index.html".into()))
        .title(title)
        .inner_size(960.0, 640.0)
        .min_inner_size(480.0, 320.0)
        // Links open in the system browser, as the main window's do.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| error.to_string())?;
    terminals.windows.lock().unwrap().insert(label.clone(), folder);
    // RUSH Lab stays in the Dock while any terminal window is open.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let terminals = handle.state::<Terminals>();
            terminals.windows.lock().unwrap().remove(&label);
            end_sessions(&handle, |session| session.window == label);
            #[cfg(target_os = "macos")]
            if !running(&handle) && handle.get_webview_window("main").is_none_or(|main| !main.is_visible().unwrap_or(false)) {
                let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        }
    });
    Ok(())
}

/// Whether any terminal window is open.
pub fn running(app: &AppHandle) -> bool {
    !app.state::<Terminals>().windows.lock().unwrap().is_empty()
}

/// End every shell: RUSH Lab is quitting.
pub fn close_all(app: &AppHandle) {
    end_sessions(app, |_| true);
}

/// End the shells `which` picks.
fn end_sessions(app: &AppHandle, which: impl Fn(&Session) -> bool) {
    let ended: Vec<Session> = app.state::<Terminals>().sessions.lock().unwrap().extract_if(|_, session| which(session)).map(|(_, session)| session).collect();
    ended.into_iter().for_each(end);
}

/// End `session`'s shell: SIGHUP to its process group, as a terminal closing sends it, on Windows
/// the ConPTY child killed; its PTY closes as it is dropped.
fn end(session: Session) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(session.pid as libc::pid_t, libc::SIGHUP);
    }
    #[cfg(windows)]
    {
        let mut child = session.child;
        let _ = child.kill();
    }
}

/// The member's login shell, their passwd entry's, as Terminal's.
#[cfg(unix)]
fn login_shell() -> Result<PathBuf, String> {
    let entry = unsafe { libc::getpwuid(libc::getuid()) };
    if entry.is_null() || unsafe { (*entry).pw_shell }.is_null() {
        return Err("this account has no login shell".into());
    }
    let shell = unsafe { std::ffi::CStr::from_ptr((*entry).pw_shell) };
    Ok(PathBuf::from(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(shell.to_bytes())))
}

/// The login shell `login`, zsh, bash or fish, reading the member's profile and then putting the
/// launchers in <terminal>/bin first on PATH (startup_files).
#[cfg(unix)]
fn login_command(login: PathBuf, terminal: &Path) -> Result<CommandBuilder, String> {
    let mut command = CommandBuilder::new(&login);
    command.env("RUSH_LAB_BIN", terminal.join("bin"));
    match login.file_name().and_then(|name| name.to_str()) {
        Some("zsh") => {
            command.arg("-l");
            // Unset, zsh reads the home folder's files.
            let home = command.get_env("HOME").ok_or("HOME is not set")?.to_os_string();
            command.env("RUSH_LAB_ZDOTDIR", command.get_env("ZDOTDIR").map(|dir| dir.to_os_string()).unwrap_or(home));
            command.env("RUSH_LAB_SHELL", terminal.join("shell"));
            command.env("ZDOTDIR", terminal.join("shell"));
        }
        Some("bash") => {
            command.arg("--rcfile");
            command.arg(terminal.join("shell").join("bashrc"));
            command.arg("-i");
        }
        // -C runs once fish has read its configuration.
        Some("fish") => command.args(["-l", "-C", "set -gx PATH $RUSH_LAB_BIN $PATH; set -e RUSH_LAB_BIN"]),
        _ => return Err(format!("The terminal runs zsh, bash or fish, and your login shell is {}", login.display())),
    }
    Ok(command)
}

/// The shell a terminal runs in `folder`: the member's login shell, on Windows PowerShell, with
/// the app's environment, a terminal's variables, and the launchers in <terminal>/bin first on PATH.
fn shell(terminal: &Path, folder: &Path) -> Result<CommandBuilder, String> {
    #[cfg(unix)]
    let mut command = login_command(login_shell()?, terminal)?;
    #[cfg(windows)]
    let mut command = CommandBuilder::new("powershell.exe");
    #[cfg(windows)]
    {
        command.arg("-NoLogo");
        let path = command.get_env("PATH").map(std::env::split_paths).into_iter().flatten();
        let path = std::env::join_paths(std::iter::once(terminal.join("bin")).chain(path)).map_err(|error| error.to_string())?;
        command.env("PATH", path);
    }
    command.cwd(folder);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "RUSH-Lab");
    // A terminal says which locale it draws, as Terminal does when the shell has none: an app
    // opened from Finder has no LANG, and a shell without one draws no UTF-8.
    if command.get_env("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
    Ok(command)
}

/// The plugin projects in the projects folder: its folders holding nanoagent.yaml.
#[tauri::command]
pub fn terminal_projects(webview: Webview) -> Result<Vec<Project>, String> {
    terminal_window(&webview)?;
    let projects = projects_folder(webview.app_handle())?;
    let entries = fs::read_dir(&projects).map_err(|error| format!("{}: {error}", projects.display()))?;
    let mut found: Vec<Project> = entries
        .flatten()
        .filter(|entry| entry.path().join("nanoagent.yaml").is_file())
        .map(|entry| Project { id: entry.file_name().to_string_lossy().into_owned(), folder: entry.path() })
        .collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(found)
}

/// Make the plugin project `id` with `nanoagent plugin new` and the skill, then open its window.
/// On failure nothing is left behind, and the error is what `plugin new` printed.
#[tauri::command]
pub async fn terminal_new_project(webview: Webview, id: String) -> Result<Project, String> {
    let (lab, _) = terminal_window(&webview)?;
    let app = webview.app_handle();
    check_id(&id)?;
    let folder = projects_folder(app)?.join(&id);
    if folder.exists() {
        return Err(format!("{} already exists", folder.display()));
    }
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?.join("terminal");
    let read = |name: &str| fs::read_to_string(resources.join(name)).map_err(|error| format!("{}: {error}", resources.join(name).display()));
    let text = skill_text(&read("project.md")?, &read("SKILL.md")?, &id);
    let launcher = write_launchers(app, &lab)?.join(if cfg!(windows) { "nanoagent.cmd" } else { "nanoagent" });
    let mut command = Command::new(launcher);
    command.args(["plugin".as_ref(), "new".as_ref(), folder.as_os_str()]);
    // Without a console window: this app has none, and Windows would open one.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let made = command.output().map_err(|error| format!("could not run nanoagent: {error}")).and_then(|output| {
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() { format!("nanoagent plugin new failed ({})", output.status) } else { stderr })
    });
    let written = made.and_then(|()| {
        SKILL_FILES.iter().try_for_each(|name| fs::write(folder.join(name), &text).map_err(|error| format!("{name}: {error}")))
    });
    if let Err(message) = written {
        let _ = fs::remove_dir_all(&folder);
        return Err(message);
    }
    open_window(app, Some(folder.clone()))?;
    Ok(Project { id, folder })
}

/// Open a window on the plugin project `id`.
#[tauri::command]
pub async fn terminal_open_project(webview: Webview, id: String) -> Result<(), String> {
    terminal_window(&webview)?;
    check_id(&id)?;
    let app = webview.app_handle();
    open_window(app, Some(projects_folder(app)?.join(id)))
}

/// Start the window's shell, `cols` by `rows`: its output goes to `output` in chunks of up to
/// CHUNK, then its exit code to `exited`. Starting it again (the page reloaded) ends the one before.
#[tauri::command]
pub fn terminal_start(webview: Webview, cols: u16, rows: u16, output: Channel<InvokeResponseBody>, exited: Channel<Option<u32>>) -> Result<u32, String> {
    let (lab, label) = terminal_window(&webview)?;
    let app = webview.app_handle().clone();
    let terminals = app.state::<Terminals>();
    let folder = terminals.windows.lock().unwrap().get(&label).cloned().ok_or_else(|| format!("{label} is not open"))?;
    let command = shell(&lab.data.join("terminal"), &folder)?;
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string())?;
    let mut child = pair.slave.spawn_command(command).map_err(|error| format!("could not start the shell: {error}"))?;
    drop(pair.slave);
    #[cfg(unix)]
    let Some(pid) = child.process_id() else {
        let _ = child.kill();
        return Err("the shell started with no process id, so closing its window could not end it".into());
    };
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let (typed, typing) = mpsc::channel::<Vec<u8>>();
    let id = terminals.next.fetch_add(1, Ordering::SeqCst);
    let session = Session {
        window: label.clone(),
        typed,
        master: pair.master,
        #[cfg(unix)]
        pid,
        #[cfg(windows)]
        child: child.clone_killer(),
    };
    {
        // Under the windows' lock, so a window closing ends this shell too: before, as its window
        // is gone, or after, as its session is in.
        let windows = terminals.windows.lock().unwrap();
        if !windows.contains_key(&label) {
            end(session);
            return Err(format!("{label} is not open"));
        }
        end_sessions(&app, |session| session.window == label);
        terminals.sessions.lock().unwrap().insert(id, session);
    }
    let said = output.clone();
    thread::spawn(move || {
        for data in typing {
            if let Err(error) = writer.write_all(&data).and_then(|()| writer.flush()) {
                let _ = said.send(InvokeResponseBody::Raw(format!("\r\n[Could not type into the shell: {error}]\r\n").into_bytes()));
                break;
            }
        }
    });
    let reading = thread::spawn(move || {
        let mut buffer = vec![0u8; CHUNK];
        while let Ok(read @ 1..) = reader.read(&mut buffer) {
            if output.send(InvokeResponseBody::Raw(buffer[..read].to_vec())).is_err() {
                break;
            }
        }
    });
    thread::spawn(move || {
        let status = child.wait();
        // Its PTY closed, the reader comes to the end of the output (ConPTY ends it only then).
        let open = app.state::<Terminals>().sessions.lock().unwrap().remove(&id).is_some();
        let _ = reading.join();
        // A shell its window ended has no one to tell.
        if open {
            let _ = exited.send(status.ok().map(|status| status.exit_code()));
        }
    });
    Ok(id)
}

/// Run `action` on the shell `id`, which must be this window's.
fn with_session<T>(webview: &Webview, id: u32, action: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let (_, label) = terminal_window(webview)?;
    let terminals = webview.app_handle().state::<Terminals>();
    let mut sessions = terminals.sessions.lock().unwrap();
    match sessions.get_mut(&id) {
        Some(session) if session.window == label => action(session),
        _ => Err(format!("this window has no shell {id}")),
    }
}

/// Type `data` into the shell `id`, in turn after what was typed before.
#[tauri::command]
pub fn terminal_write(webview: Webview, id: u32, data: String) -> Result<(), String> {
    with_session(&webview, id, |session| session.typed.send(data.into_bytes()).map_err(|_| "the shell no longer reads what is typed".to_string()))
}

/// The shell `id`'s terminal is now `cols` by `rows`.
#[tauri::command]
pub fn terminal_resize(webview: Webview, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    with_session(&webview, id, |session| session.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_kebab_case() {
        for id in ["arxiv-source", "a", "a1-b2-c3"] {
            assert!(check_id(id).is_ok(), "{id}");
        }
        for id in ["", "-a", "a-", "a--b", "A", "a_b", "a b", "../a", "a/b", "é"] {
            assert!(check_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn a_folder_outside_the_projects_folder_is_refused() {
        let base = std::env::temp_dir().join(format!("rushlab-terminal-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (projects, outside) = (base.join("projects"), base.join("outside"));
        fs::create_dir_all(projects.join("echo")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        assert!(inside(&projects, &projects.join("echo")).is_ok());
        assert!(inside(&projects, &projects).is_ok());
        assert!(inside(&projects, &projects.join("..").join("outside")).is_err());
        assert!(inside(&projects, &projects.join("missing")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, projects.join("link")).unwrap();
            assert!(inside(&projects, &projects.join("link")).is_err());
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn each_launcher_runs_the_installed_build_quoted() {
        let root = Path::new("/Users/a b/Library/Application Support/lab.mochi.lab/app/it's/mochi-lab");
        let quoted = r"'/Users/a b/Library/Application Support/lab.mochi.lab/app/it'\''s/mochi-lab";
        let launchers: HashMap<String, String> = launchers(root, "RUSH Lab Dev").into_iter().collect();
        let nanoagent = &launchers["nanoagent"];
        assert!(nanoagent.starts_with("#!/bin/sh\n"));
        assert!(nanoagent.contains(&format!("[ -e {quoted}/nanoagent/.venv/bin/python' ] || missing\n")));
        assert!(nanoagent.contains(&format!("PATH={quoted}/bin':\"$PATH\" exec {quoted}/nanoagent/.venv/bin/python' -I -m nanoagent \"$@\"\n")));
        assert!(nanoagent.contains("missing() { echo 'RUSH Lab Dev is still setting up NanoAgent (menu bar → Show Logs)' >&2; exit 1; }"));
        assert!(launchers["uv"].ends_with(&format!("exec {quoted}/bin/uv' \"$@\"\n")));
        let rushlab = &launchers["rushlab"];
        assert!(rushlab.contains(&format!("[ -e {quoted}/bin/node' ] || missing\n[ -e {quoted}/runner/lab.mjs' ] || missing\n")));
        assert!(rushlab.ends_with(&format!("exec {quoted}/bin/node' {quoted}/runner/lab.mjs' rushlab \"$@\"\n")));
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_whose_build_is_not_set_up_says_so() {
        let launchers: HashMap<String, String> = launchers(Path::new("/nonexistent/mochi-lab"), "RUSH Lab").into_iter().collect();
        let output = Command::new("sh").arg("-c").arg(&launchers["nanoagent"]).output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(String::from_utf8_lossy(&output.stderr).trim(), missing("RUSH Lab"));
    }

    /// What `login` prints for `command -v nanoagent` in a PTY, the member's profile in `home`
    /// putting a `nanoagent` of their own first on PATH.
    #[cfg(unix)]
    fn nanoagent_found_by(login: &str, base: &Path) -> (String, PathBuf, PathBuf) {
        let (terminal, home, theirs) = (base.join("terminal"), base.join("home"), base.join("theirs"));
        for folder in [terminal.join("bin"), home.clone(), theirs.clone()] {
            fs::create_dir_all(&folder).unwrap();
        }
        for bin in [terminal.join("bin"), theirs.clone()] {
            write_whole(&bin.join("nanoagent"), "#!/bin/sh\n", true).unwrap();
        }
        let profile = format!("export PATH={}:\"$PATH\"\n", quote(&theirs));
        for name in [".zprofile", ".zshrc", ".bash_profile"] {
            fs::write(home.join(name), &profile).unwrap();
        }
        write_startup(&terminal).unwrap();
        let mut command = login_command(PathBuf::from(login), &terminal).unwrap();
        command.env("HOME", &home);
        command.env("RUSH_LAB_ZDOTDIR", &home);
        command.cwd(base);
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 200, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        pair.master.take_writer().unwrap().write_all(b"command -v nanoagent; exit\n").unwrap();
        let mut output = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(read @ 1..) = reader.read(&mut buffer) {
            output.extend_from_slice(&buffer[..read]);
        }
        child.wait().unwrap();
        (String::from_utf8_lossy(&output).into_owned(), terminal.join("bin").join("nanoagent"), theirs.join("nanoagent"))
    }

    #[cfg(unix)]
    #[test]
    fn the_launchers_come_first_once_the_members_profile_has_run() {
        for login in ["/bin/zsh", "/bin/bash"] {
            let base = std::env::temp_dir().join(format!("rushlab-terminal-shell-{}-{}", std::process::id(), &login[5..]));
            let _ = fs::remove_dir_all(&base);
            let (output, ours, theirs) = nanoagent_found_by(login, &base);
            assert!(output.contains(&ours.display().to_string()), "{login}: {output}");
            assert!(!output.contains(&theirs.display().to_string()), "{login}: {output}");
            fs::remove_dir_all(&base).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_but_zsh_bash_or_fish_is_refused() {
        let refused = login_command(PathBuf::from("/bin/tcsh"), Path::new("/t")).err().unwrap();
        assert_eq!(refused, "The terminal runs zsh, bash or fish, and your login shell is /bin/tcsh");
    }

    #[test]
    fn the_skill_files_are_the_preface_for_the_id_then_the_whole_skill() {
        let preface = include_str!("../../terminal/project.md");
        let skill = include_str!("../../../../docs/instructions/skills/publish-plugin/SKILL.md");
        let text = skill_text(preface, skill, "word-count");
        assert!(text.starts_with("# This folder is the plugin word-count\n"));
        assert!(!text.contains("{{id}}"));
        assert!(text.contains("`rushlab preview .`"));
        assert!(text.ends_with(skill));
        assert_eq!(text, format!("{}\n{skill}", preface.replace("{{id}}", "word-count")));
    }
}
