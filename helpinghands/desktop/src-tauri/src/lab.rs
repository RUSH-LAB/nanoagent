//! What runs behind RUSH Lab's window and menu-bar icon: src/runner/lab.mjs, which serves every connection
//! on this computer (a NanoAgent and a relay for each member connected here).
//!
//! The app bundles Node, uv and git (its shell), and the engine it was built with: lab.mjs with the
//! relay and NanoAgent (scripts/stage.mjs, scripts/engine.mjs). Each engine is installed once into
//! the data folder's app/<stamp>/mochi-lab/, with the shell's own files beside it, the layout
//! lab.mjs runs from, because NanoAgent's .venv is made beside it. The app runs the newest engine
//! it has for its shell, the one it was built with or a newer one its site served (engine.rs).
//! lab.mjs runs from there while the app is open, and starts again when it exits; quitting the app
//! stops it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

// lab.mjs takes up to 10s to stop each service of each connection.
#[cfg(unix)]
const STOP_TIMEOUT: Duration = Duration::from_secs(60);
const RESTART: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(250);

/// config.json, bundled by scripts/stage.mjs: RUSH Lab's, or RUSH Lab Dev's (config.yaml).
#[derive(Deserialize)]
pub struct Config {
    /// The app's name, which its menu, dialogs and windows say.
    pub product_name: String,
    label: String,
    /// The scheme of the app's links: <scheme>://connect and ://sign-in.
    pub scheme: String,
    /// The RUSH this app serves, which its window shows.
    pub site_url: String,
    /// A release's target, which it updates itself as (update.rs); None for any other build.
    pub update_target: Option<String>,
}

pub struct Lab {
    /// ~/Library/Application Support/<label>/, on Windows %LOCALAPPDATA%\<label>\: lab.mjs's data folder.
    pub data: PathBuf,
    /// The app's bundled files.
    resources: PathBuf,
    /// The shell this app is (scripts/shell.mjs), which an engine must be made for.
    pub shell: String,
    /// The engine lab.mjs runs, installed: app/<stamp>/mochi-lab/.
    root: Mutex<PathBuf>,
    child: Mutex<Option<Child>>,
    /// Which run of lab.mjs is current: a switch to another engine ends the one before.
    generation: AtomicU64,
    /// The engine the site last named that this app did not take (engine.rs).
    declined: Mutex<String>,
    stopping: AtomicBool,
}

/// config.json, as this build bundles it.
pub fn config(app: &AppHandle) -> Result<Config, String> {
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    let config_file = resources.join("config.json");
    let text = fs::read_to_string(&config_file).map_err(|error| format!("{}: {error}", config_file.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", config_file.display()))
}

impl Lab {
    /// Install the engine this app was built with, once, and pick the newest installed for its
    /// shell, removing the others; before that, stop and remove the RUSH Lab the one-line install
    /// had launchd run, whose connections this one serves from now.
    pub fn install(app: &AppHandle) -> Result<Self, String> {
        let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
        let config = config(app)?;
        let data = app.path().local_data_dir().map_err(|error| error.to_string())?.join(&config.label);
        #[cfg(target_os = "macos")]
        remove_launch_agent(app, &config)?;
        let read = |file: &str| fs::read_to_string(resources.join(file)).map(|text| text.trim().to_string()).map_err(|error| format!("{file}: {error}"));
        let (stamp, shell) = (read("stamp")?, read("shell")?);
        let lab = Self {
            data: data.clone(),
            resources: resources.clone(),
            shell,
            root: Mutex::new(PathBuf::new()),
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
            declined: Mutex::new(String::new()),
            stopping: AtomicBool::new(false),
        };
        let apps = lab.apps();
        let bundled = apps.join(&stamp);
        if !lab.made_for_shell(&bundled) {
            let partial = apps.join(format!("{stamp}.partial"));
            let _ = fs::remove_dir_all(&partial);
            let root = partial.join("mochi-lab");
            for part in ["runner", "nanoagent"] {
                copy_dir(&resources.join(part), &root.join(part)).map_err(|error| format!("installing {part}: {error}"))?;
            }
            for file in ["stamp", "shell"] {
                fs::copy(resources.join(file), root.join(file)).map_err(|error| format!("installing {file}: {error}"))?;
            }
            lab.add_shell(&root)?;
            let _ = fs::remove_dir_all(&bundled);
            fs::rename(&partial, &bundled).map_err(|error| error.to_string())?;
        }
        // Stamps start with their build's time, so the newest sorts last.
        let newest = fs::read_dir(&apps)
            .map_err(|error| error.to_string())?
            .flatten()
            .map(|entry| entry.path())
            .filter(|folder| lab.made_for_shell(folder))
            .max()
            .ok_or("no engine is installed")?;
        fs::create_dir_all(data.join("logs")).map_err(|error| error.to_string())?;
        lab.run_from(newest.join("mochi-lab"));
        Ok(lab)
    }

    /// The data folder's app/, where each engine is installed.
    pub fn apps(&self) -> PathBuf {
        self.data.join("app")
    }

    /// Whether `folder` (app/<stamp>) is an engine installed whole, for this shell.
    fn made_for_shell(&self, folder: &Path) -> bool {
        let named = folder.file_name().and_then(|name| name.to_str()).is_some_and(|name| !name.ends_with(".partial"));
        named && fs::read_to_string(folder.join("mochi-lab/shell")).is_ok_and(|shell| shell.trim() == self.shell)
    }

    /// Add the shell's files beside the engine in `root`: its config.json, its git, and the runtimes.
    pub fn add_shell(&self, root: &Path) -> Result<(), String> {
        copy_dir(&self.resources.join("git"), &root.join("git")).map_err(|error| format!("installing git: {error}"))?;
        fs::copy(self.resources.join("config.json"), root.join("config.json")).map_err(|error| format!("installing config.json: {error}"))?;
        // The bundled runtimes are beside this executable.
        let current = std::env::current_exe().map_err(|error| error.to_string())?;
        let bin = current.parent().ok_or("the executable has no folder")?;
        fs::create_dir_all(root.join("bin")).map_err(|error| error.to_string())?;
        for name in [exe("node"), exe("uv")] {
            fs::copy(bin.join(&name), root.join("bin").join(&name)).map_err(|error| format!("installing {name}: {error}"))?;
        }
        Ok(())
    }

    /// Run the engine in `root` from now on, removing the others: before lab.mjs starts (`switch`
    /// once it runs).
    pub fn run_from(&self, root: PathBuf) {
        *self.root.lock().unwrap() = root;
        self.remove_others();
    }

    /// The engine's stamp in `root`.
    pub fn stamp_of(&self, root: &Path) -> String {
        fs::read_to_string(root.join("stamp")).map(|stamp| stamp.trim().to_string()).unwrap_or_default()
    }

    /// The engine the site last named that this app did not take.
    pub fn declined(&self) -> String {
        self.declined.lock().unwrap().clone()
    }

    /// Take the engine `stamp` no more, until the site names another.
    pub fn decline(&self, stamp: String) {
        *self.declined.lock().unwrap() = stamp;
    }

    /// The stamp of the engine lab.mjs runs.
    pub fn stamp(&self) -> String {
        self.stamp_of(&self.root.lock().unwrap())
    }

    /// Remove every engine in app/ but the one lab.mjs runs.
    fn remove_others(&self) {
        let current = self.root.lock().unwrap().parent().map(Path::to_path_buf);
        for entry in fs::read_dir(self.apps()).into_iter().flatten().flatten() {
            let old = entry.path();
            if Some(&old) != current.as_ref() {
                let removed = if old.is_dir() && !old.is_symlink() { fs::remove_dir_all(&old) } else { fs::remove_file(&old) };
                if let Err(error) = removed {
                    self.log(&format!("Could not remove {}: {error}", old.display()));
                }
            }
        }
    }

    fn node(&self) -> Command {
        let root = self.root.lock().unwrap().clone();
        let mut command = Command::new(root.join("bin").join(exe("node")));
        command.arg(root.join("runner/lab.mjs")).current_dir(root.join("runner"));
        // Without a console window: this app has none, and Windows would open one for node.
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        command
    }

    /// Run lab.mjs, its output in logs/lab.log, starting it again RESTART after it exits, until `stop`
    /// or a `switch`.
    pub fn start(self: &Arc<Self>) {
        let lab = self.clone();
        let generation = self.generation.load(Ordering::SeqCst);
        thread::spawn(move || {
            let log = lab.data.join("logs/lab.log");
            let ended = || lab.stopping.load(Ordering::SeqCst) || lab.generation.load(Ordering::SeqCst) != generation;
            loop {
                // Under the lock `stop` and `switch` take, so nothing starts once they have.
                let mut slot = lab.child.lock().unwrap();
                if ended() {
                    return;
                }
                let spawned = fs::OpenOptions::new().create(true).append(true).open(&log).and_then(|out| {
                    let err = out.try_clone()?;
                    lab.node().stdin(Stdio::null()).stdout(out).stderr(err).spawn()
                });
                let message = match spawned {
                    Ok(child) => {
                        *slot = Some(child);
                        drop(slot);
                        loop {
                            let status = lab.child.lock().unwrap().as_mut().map(|child| child.try_wait());
                            match status {
                                Some(Ok(Some(status))) => break format!("lab.mjs exited ({status})"),
                                Some(Ok(None)) => thread::sleep(POLL),
                                Some(Err(error)) => break format!("lab.mjs could not be watched: {error}"),
                                // Stopped by `stop` or `switch`.
                                None => return,
                            }
                        }
                    }
                    Err(error) => {
                        drop(slot);
                        format!("could not start lab.mjs: {error}")
                    }
                };
                if ended() {
                    return;
                }
                append(&log, &format!("{message}; starting it again in {}s.", RESTART.as_secs()));
                let deadline = Instant::now() + RESTART;
                while Instant::now() < deadline && !ended() {
                    thread::sleep(POLL);
                }
            }
        });
    }

    /// Quit: stop lab.mjs (`end`), and start it no more.
    pub fn stop(&self) {
        let mut slot = self.child.lock().unwrap();
        self.stopping.store(true, Ordering::SeqCst);
        let Some(child) = slot.take() else { return };
        drop(slot);
        end(child);
    }

    /// Run the engine in `root` in place of the one running: lab.mjs stops as at quitting, starts
    /// again from `root`, and the engine before is removed.
    pub fn switch(self: &Arc<Self>, root: PathBuf) {
        let mut slot = self.child.lock().unwrap();
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        let child = slot.take();
        drop(slot);
        if let Some(child) = child {
            end(child);
        }
        self.run_from(root);
        self.start();
    }

    /// Whether nothing runs here: lab.mjs keeps the data folder's `busy` while any connection's relay
    /// has a request of RUSH's going, a held run included.
    pub fn idle(&self) -> bool {
        !self.data.join("busy").exists()
    }

    /// One line in logs/lab.log.
    pub fn log(&self, line: &str) {
        append(&self.data.join("logs/lab.log"), line);
    }

    /// Ask lab.mjs `args` about a connect link whose token is `token`: what it prints, or why it failed.
    pub fn ask(&self, args: &[&str], token: &str) -> Result<String, String> {
        let output = self.node().args(args).env("LAB_TOKEN", token).stdin(Stdio::null()).output().map_err(|error| format!("could not run lab.mjs: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // lab.mjs's lines begin with their time.
            return Err(stderr.trim().split_once(' ').map_or(stderr.trim(), |(_, message)| message).to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

/// The one-line install had launchd run lab.mjs as the app's label: stop it, and keep launchd from starting it again.
#[cfg(target_os = "macos")]
fn remove_launch_agent(app: &AppHandle, config: &Config) -> Result<(), String> {
    let label = &config.label;
    let plist = app.path().home_dir().map_err(|error| error.to_string())?.join("Library/LaunchAgents").join(format!("{label}.plist"));
    if !plist.exists() {
        return Ok(());
    }
    let service = format!("gui/{}/{label}", unsafe { libc::getuid() });
    let loaded = || Command::new("launchctl").args(["print", &service]).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success());
    if loaded() {
        let _ = Command::new("launchctl").args(["bootout", &service]).status();
        let deadline = Instant::now() + STOP_TIMEOUT;
        while loaded() {
            if Instant::now() > deadline {
                return Err(format!("the {} installed with the terminal command ({service}) did not stop within {}s", config.product_name, STOP_TIMEOUT.as_secs()));
            }
            thread::sleep(Duration::from_secs(1));
        }
    }
    fs::remove_file(&plist).map_err(|error| format!("removing {}: {error}", plist.display()))
}


/// Stop lab.mjs: SIGTERM so it stops every connection cleanly, SIGKILL after STOP_TIMEOUT. Windows
/// has no signals, so there lab.mjs is killed with every service it started.
fn end(mut child: Child) {
    #[cfg(unix)]
    {
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline && child.try_wait().ok().flatten().is_none() {
            thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(0x0800_0000).output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

fn append(log: &Path, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(file, "{line}");
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
