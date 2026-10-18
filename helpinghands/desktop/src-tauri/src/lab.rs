//! What runs behind RUSH Lab's window and menu-bar icon: src/runner/lab.mjs, which serves every connection
//! on this computer (a NanoAgent and a relay for each member connected here).
//!
//! The app bundles lab.mjs with the relay, NanoAgent, Node, uv and git
//! (scripts/stage.mjs).
//! Each build is installed once into the data folder's app/<stamp>/mochi-lab/, the layout lab.mjs
//! runs from, because NanoAgent's .venv is made beside it. lab.mjs runs from there while the app is
//! open, and starts again when it exits; quitting the app stops it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// The Mochi this app serves, which its window shows.
    pub site_url: String,
    /// A release's target, which it updates itself as (update.rs); None for any other build.
    pub update_target: Option<String>,
}

pub struct Lab {
    /// ~/Library/Application Support/<label>/, on Windows %LOCALAPPDATA%\<label>\: lab.mjs's data folder.
    pub data: PathBuf,
    /// This build's files, installed: app/<stamp>/mochi-lab/.
    root: PathBuf,
    child: Mutex<Option<Child>>,
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
    /// Install this build, once, removing the others; before that, stop and remove the RUSH Lab the
    /// one-line install had launchd run, whose connections this one serves from now.
    pub fn install(app: &AppHandle) -> Result<Self, String> {
        let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
        let config = config(app)?;
        let data = app.path().local_data_dir().map_err(|error| error.to_string())?.join(&config.label);
        #[cfg(target_os = "macos")]
        remove_launch_agent(app, &config)?;
        let stamp_file = resources.join("stamp");
        let stamp = fs::read_to_string(&stamp_file).map_err(|error| format!("{}: {error}", stamp_file.display()))?;
        let apps = data.join("app");
        let installed = apps.join(stamp.trim());
        if !installed.exists() {
            let partial = apps.join(format!("{}.partial", stamp.trim()));
            let _ = fs::remove_dir_all(&partial);
            let root = partial.join("mochi-lab");
            for part in ["runner", "nanoagent", "git"] {
                copy_dir(&resources.join(part), &root.join(part)).map_err(|error| format!("installing {part}: {error}"))?;
            }
            for file in ["stamp", "config.json"] {
                fs::copy(resources.join(file), root.join(file)).map_err(|error| format!("installing {file}: {error}"))?;
            }
            // The bundled runtimes are beside this executable.
            let current = std::env::current_exe().map_err(|error| error.to_string())?;
            let bin = current.parent().ok_or("the executable has no folder")?;
            fs::create_dir_all(root.join("bin")).map_err(|error| error.to_string())?;
            for name in [exe("node"), exe("uv")] {
                fs::copy(bin.join(&name), root.join("bin").join(&name)).map_err(|error| format!("installing {name}: {error}"))?;
            }
            for entry in fs::read_dir(&apps).map_err(|error| error.to_string())?.flatten() {
                let old = entry.path();
                if old != partial {
                    let removed = if old.is_dir() && !old.is_symlink() { fs::remove_dir_all(&old) } else { fs::remove_file(&old) };
                    removed.map_err(|error| format!("removing {}: {error}", old.display()))?;
                }
            }
            fs::rename(&partial, &installed).map_err(|error| error.to_string())?;
        }
        fs::create_dir_all(data.join("logs")).map_err(|error| error.to_string())?;
        Ok(Self {
            root: installed.join("mochi-lab"),
            data,
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
        })
    }

    fn node(&self) -> Command {
        let mut command = Command::new(self.root.join("bin").join(exe("node")));
        command.arg(self.root.join("runner/lab.mjs")).current_dir(self.root.join("runner"));
        // Without a console window: this app has none, and Windows would open one for node.
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        command
    }

    /// Run lab.mjs, its output in logs/lab.log, starting it again RESTART after it exits, until `stop`.
    pub fn start(self: &Arc<Self>) {
        let lab = self.clone();
        thread::spawn(move || {
            let log = lab.data.join("logs/lab.log");
            loop {
                // Under the lock `stop` takes, so nothing starts once it has.
                let mut slot = lab.child.lock().unwrap();
                if lab.stopping.load(Ordering::SeqCst) {
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
                                // Stopped by `stop`.
                                None => return,
                            }
                        }
                    }
                    Err(error) => {
                        drop(slot);
                        format!("could not start lab.mjs: {error}")
                    }
                };
                if lab.stopping.load(Ordering::SeqCst) {
                    return;
                }
                append(&log, &format!("{message}; starting it again in {}s.", RESTART.as_secs()));
                let deadline = Instant::now() + RESTART;
                while Instant::now() < deadline && !lab.stopping.load(Ordering::SeqCst) {
                    thread::sleep(POLL);
                }
            }
        });
    }

    /// Quit: SIGTERM so lab.mjs stops every connection cleanly, SIGKILL after STOP_TIMEOUT. Windows
    /// has no signals, so there lab.mjs is killed with every service it started.
    pub fn stop(&self) {
        let mut slot = self.child.lock().unwrap();
        self.stopping.store(true, Ordering::SeqCst);
        let Some(mut child) = slot.take() else { return };
        drop(slot);
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

    /// Whether nothing runs here: lab.mjs keeps the data folder's `busy` while any connection's relay
    /// has a request of Mochi's going, a held run included.
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
