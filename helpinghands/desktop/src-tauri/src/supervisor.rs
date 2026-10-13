//! Runs Mochi's two services behind the window, from copies the app installs.
//!
//! The bundle (scripts/stage.mjs) carries the Mochi server, NanoAgent, Node, and uv. Each staging
//! is installed once into the app's data folder, because both services write beside their code:
//! Mochi its var/, NanoAgent its .venv and its plugins' environments. Startup then runs
//! `uv sync`, starts NanoAgent and waits for its default profile, starts the Mochi server and
//! waits for /api/health, and opens the window on the site. The splash (splash/index.html) polls
//! `status` throughout; every failure, and the first-run settings, show there.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

const NANOAGENT_TIMEOUT: Duration = Duration::from_secs(60);
// The server applies migrations to PostgreSQL before it listens.
const MOCHI_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);
const LOG_TAIL_LINES: usize = 30;
// What the services see of this process's environment; everything else comes from settings.
const SYSTEM_ENV: &[&str] = &[
    "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR",
    "SystemRoot", "SystemDrive", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "COMSPEC", "PATHEXT",
];

/// config.yaml, bundled by scripts/stage.mjs.
#[derive(Deserialize)]
pub struct Config {
    pub port: u16,
    pub nanoagent_port: u16,
    pub python_version: String,
}

impl Config {
    pub fn origin(&self) -> String {
        format!("http://localhost:{}", self.port)
    }
}

#[derive(Clone, Serialize)]
pub struct Status {
    /// starting | setup | failed | running
    phase: &'static str,
    message: String,
    settings: String,
}

struct Service {
    name: &'static str,
    child: Child,
    log: PathBuf,
}

pub struct Supervisor {
    pub config: Config,
    resources: PathBuf,
    data: PathBuf,
    /// The folder holding the bundled node and uv: beside this executable.
    bin: PathBuf,
    splash: Mutex<Option<Url>>,
    status: Mutex<Status>,
    services: Mutex<Vec<Service>>,
    stopping: AtomicBool,
}

impl Supervisor {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
        let data = app.path().app_data_dir().map_err(|error| error.to_string())?;
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let config_file = resources.join("config.yaml");
        let text = fs::read_to_string(&config_file).map_err(|error| format!("{}: {error}", config_file.display()))?;
        let config: Config = serde_yaml::from_str(&text).map_err(|error| format!("{}: {error}", config_file.display()))?;
        let settings = data.join("settings.env").display().to_string();
        Ok(Self {
            config,
            resources,
            data,
            bin: exe.parent().ok_or("the executable has no folder")?.to_path_buf(),
            splash: Mutex::new(None),
            status: Mutex::new(Status { phase: "starting", message: "Starting…".into(), settings }),
            services: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false),
        })
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set(&self, phase: &'static str, message: impl Into<String>) {
        let mut status = self.status.lock().unwrap();
        status.phase = phase;
        status.message = message.into();
    }

    fn settings_file(&self) -> PathBuf {
        self.data.join("settings.env")
    }

    /// The services this app has running: one `pid<TAB>program` line each.
    fn pid_file(&self) -> PathBuf {
        self.data.join("services.pid")
    }

    /// Stop the services a previous run left behind when it was killed or crashed: each
    /// recorded process that is still running the program it was started with.
    #[cfg(unix)]
    fn stop_leftovers(&self) {
        let Ok(text) = fs::read_to_string(self.pid_file()) else { return };
        for (pid, program) in text.lines().filter_map(|line| line.split_once('\t')) {
            let Ok(pid) = pid.parse::<libc::pid_t>() else { continue };
            let command = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output();
            let running = command.is_ok_and(|output| String::from_utf8_lossy(&output.stdout).starts_with(program));
            if !running {
                continue;
            }
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let deadline = Instant::now() + STOP_TIMEOUT;
            while Instant::now() < deadline && unsafe { libc::kill(pid, 0) } == 0 {
                thread::sleep(Duration::from_millis(100));
            }
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = fs::remove_file(self.pid_file());
    }

    /// Run startup on its own thread; the window's splash follows it through `status`.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        if let Some(window) = app.get_webview_window("main") {
            *self.splash.lock().unwrap() = window.url().ok();
        }
        self.stopping.store(false, Ordering::SeqCst);
        self.set("starting", "Starting…");
        let supervisor = self.clone();
        thread::spawn(move || match supervisor.run(&app) {
            Ok(true) => supervisor.watch(&app),
            Ok(false) => {}
            Err(message) => supervisor.fail(&app, message),
        });
    }

    /// Start again after a failure or once settings are saved; refused while anything runs.
    pub fn restart(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        let phase = self.status().phase;
        if phase != "failed" && phase != "setup" {
            return Err(format!("Mochi Lab is {phase}"));
        }
        self.start(app);
        Ok(())
    }

    pub fn save_settings(self: &Arc<Self>, app: AppHandle, contents: &str) -> Result<(), String> {
        parse_env(contents)?;
        let phase = self.status().phase;
        if phase != "failed" && phase != "setup" {
            return Err(format!("Mochi Lab is {phase}"));
        }
        fs::create_dir_all(&self.data).map_err(|error| error.to_string())?;
        write_private(&self.settings_file(), contents)?;
        self.restart(app)
    }

    fn fail(&self, app: &AppHandle, message: String) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        self.stop_services();
        self.set("failed", message);
        let splash = self.splash.lock().unwrap().clone();
        if let (Some(window), Some(splash)) = (app.get_webview_window("main"), splash) {
            let _ = window.navigate(splash);
        }
    }

    /// Startup. Ok(false) when it stopped for settings or because the app is quitting.
    fn run(&self, app: &AppHandle) -> Result<bool, String> {
        let settings_file = self.settings_file();
        if !settings_file.exists() {
            self.set("setup", "Mochi Lab needs its settings.");
            return Ok(false);
        }
        let text = fs::read_to_string(&settings_file).map_err(|error| format!("{}: {error}", settings_file.display()))?;
        let settings = parse_env(&text).map_err(|error| format!("{}: {error}", settings_file.display()))?;

        #[cfg(unix)]
        self.stop_leftovers();
        let (port, nanoagent_port) = (self.config.port, self.config.nanoagent_port);
        let occupied: Vec<String> = [port, nanoagent_port].into_iter().filter(|&port| listening(port)).map(|port| port.to_string()).collect();
        if !occupied.is_empty() {
            return Err(format!("Port {} already in use. Quit whatever is using it, then retry.", occupied.join(", ")));
        }

        let app_dir = self.install()?;
        let mochi = app_dir.join("mochi");
        let nanoagent = app_dir.join("nanoagent");
        let logs = self.data.join("logs");
        fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
        let env = self.environment(&settings);

        self.set("starting", "Preparing NanoAgent's Python environment (the first launch downloads Python)…");
        let uv_log = logs.join("uv-sync.log");
        let uv_status = Command::new(self.bin.join(exe("uv")))
            .args(["sync", "--locked", "--no-dev", "--extra", "web", "--managed-python", "--python", &self.config.python_version])
            .current_dir(&nanoagent)
            .env_clear()
            .envs(&env)
            .stdin(Stdio::null())
            .stdout(open_log(&uv_log)?)
            .stderr(open_log_append(&uv_log)?)
            .status()
            .map_err(|error| format!("could not run uv: {error}"))?;
        if !uv_status.success() {
            return Err(format!("uv sync failed ({uv_status}).\n\n{}", tail(&uv_log)));
        }
        if self.stopping.load(Ordering::SeqCst) {
            return Ok(false);
        }

        self.set("starting", "Starting NanoAgent…");
        let plugins = serde_json::to_string(&plugin_folders(&nanoagent.join("plugins"))?).unwrap();
        let workspaces = self.data.join("agent-workspaces");
        let installs = self.data.join("nanoagent-installs");
        let python = nanoagent.join(".venv").join(if cfg!(windows) { "Scripts/python.exe" } else { "bin/python" });
        let nanoagent_args = vec![
            "-m".to_string(), "nanoagent".into(), "web".into(),
            "web_cfg=deploy/railway/nanoagent.yaml".into(),
            "host=127.0.0.1".into(),
            format!("port={nanoagent_port}"),
            "api_token=null".into(),
            // The desktop runs plugins as the user who runs it, like any program they start.
            "sandbox=none".into(),
            format!("packages={plugins}"),
            format!("workspaces={}", serde_json::to_string(&workspaces.display().to_string()).unwrap()),
            format!("installs={}", serde_json::to_string(&installs.display().to_string()).unwrap()),
        ];
        self.spawn("NanoAgent", &python, &nanoagent_args, &nanoagent, &env, &logs.join("nanoagent.log"))?;
        if !self.wait_until("NanoAgent", NANOAGENT_TIMEOUT, || nanoagent_ready(nanoagent_port))? {
            return Ok(false);
        }

        self.set("starting", "Starting Mochi…");
        let mut mochi_env = env.clone();
        mochi_env.insert("NODE_ENV".into(), "production".into());
        mochi_env.insert("MOCHI_DESKTOP".into(), "1".into());
        mochi_env.insert("EDITOR_PORT".into(), port.to_string());
        mochi_env.insert("SITE_URL".into(), self.config.origin());
        mochi_env.insert("NANOAGENT_URL".into(), format!("http://127.0.0.1:{nanoagent_port}"));
        mochi_env.remove("NANOAGENT_API_TOKEN");
        let node = self.bin.join(exe("node"));
        self.spawn("Mochi", &node, &["src/server/index.js".to_string()], &mochi, &mochi_env, &logs.join("mochi.log"))?;
        if !self.wait_until("Mochi", MOCHI_TIMEOUT, || Ok(http_get(port, "/api/health").is_some_and(|(code, _)| code == 200)))? {
            return Ok(false);
        }

        self.set("running", self.config.origin());
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(Url::parse(&self.config.origin()).unwrap());
        }
        Ok(true)
    }

    /// Install this staging into data/app/<stamp> once, carrying Mochi's var/ over from the last
    /// installation and removing the others.
    fn install(&self) -> Result<PathBuf, String> {
        let stamp_file = self.resources.join("stamp");
        let stamp = fs::read_to_string(&stamp_file).map_err(|error| format!("{}: {error}", stamp_file.display()))?;
        let apps = self.data.join("app");
        let target = apps.join(stamp.trim());
        if target.exists() {
            return Ok(target);
        }
        self.set("starting", "Installing this version of Mochi Lab…");
        let partial = apps.join(format!("{}.partial", stamp.trim()));
        let _ = fs::remove_dir_all(&partial);
        for part in ["mochi", "nanoagent"] {
            copy_dir(&self.resources.join(part), &partial.join(part)).map_err(|error| format!("installing {part}: {error}"))?;
        }
        for entry in fs::read_dir(&apps).map_err(|error| error.to_string())?.flatten() {
            let old = entry.path();
            if old == partial {
                continue;
            }
            let var = old.join("mochi").join("var");
            if var.is_dir() && !partial.join("mochi").join("var").exists() {
                fs::rename(&var, partial.join("mochi").join("var")).map_err(|error| format!("moving {}: {error}", var.display()))?;
            }
            fs::remove_dir_all(&old).map_err(|error| format!("removing {}: {error}", old.display()))?;
        }
        fs::rename(&partial, &target).map_err(|error| error.to_string())?;
        Ok(target)
    }

    /// The services' environment: the system basics, the settings, and the bundled runtimes first
    /// on PATH (NanoAgent runs `node` for its PI runner and plugins run `uv`).
    fn environment(&self, settings: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> = SYSTEM_ENV.iter().filter_map(|name| std::env::var(name).ok().map(|value| (name.to_string(), value))).collect();
        env.extend(settings.clone());
        let system_path = if cfg!(windows) { std::env::var("PATH").unwrap_or_default() } else { "/usr/bin:/bin:/usr/sbin:/sbin".into() };
        let separator = if cfg!(windows) { ";" } else { ":" };
        env.insert("PATH".into(), format!("{}{separator}{system_path}", self.bin.display()));
        env
    }

    fn spawn(&self, name: &'static str, program: &Path, args: &[String], cwd: &Path, env: &BTreeMap<String, String>, log: &Path) -> Result<(), String> {
        let child = Command::new(program)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(open_log(log)?)
            .stderr(open_log_append(log)?)
            .spawn()
            .map_err(|error| format!("could not start {name} ({}): {error}", program.display()))?;
        let record = format!("{}\t{}\n", child.id(), program.display());
        fs::OpenOptions::new().create(true).append(true).open(self.pid_file())
            .and_then(|mut file| file.write_all(record.as_bytes()))
            .map_err(|error| format!("{}: {error}", self.pid_file().display()))?;
        self.services.lock().unwrap().push(Service { name, child, log: log.to_path_buf() });
        Ok(())
    }

    /// Wait for `ready`, failing when a service exits or `timeout` passes.
    /// Ok(false) when the app is quitting.
    fn wait_until(&self, name: &str, timeout: Duration, ready: impl Fn() -> Result<bool, String>) -> Result<bool, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                return Ok(false);
            }
            if let Some(message) = self.exited() {
                return Err(message);
            }
            if ready()? {
                return Ok(true);
            }
            if Instant::now() > deadline {
                let log = self.services.lock().unwrap().last().map(|service| tail(&service.log)).unwrap_or_default();
                return Err(format!("{name} did not become ready within {}s.\n\n{log}", timeout.as_secs()));
            }
            thread::sleep(POLL);
        }
    }

    /// The first service that has exited, described with its log.
    fn exited(&self) -> Option<String> {
        let mut services = self.services.lock().unwrap();
        services.iter_mut().find_map(|service| {
            let status = service.child.try_wait().ok().flatten()?;
            Some(format!("{} exited ({status}).\n\n{}", service.name, tail(&service.log)))
        })
    }

    fn watch(&self, app: &AppHandle) {
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            if let Some(message) = self.exited() {
                return self.fail(app, message);
            }
            thread::sleep(POLL);
        }
    }

    /// Quit: stop startup and every service.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_services();
    }

    /// Mochi first, then NanoAgent: SIGTERM so each shuts down cleanly, SIGKILL after STOP_TIMEOUT.
    fn stop_services(&self) {
        let mut services = self.services.lock().unwrap();
        while let Some(mut service) = services.pop() {
            if service.child.try_wait().ok().flatten().is_some() {
                continue;
            }
            #[cfg(unix)]
            unsafe {
                libc::kill(service.child.id() as libc::pid_t, libc::SIGTERM);
            }
            let deadline = Instant::now() + STOP_TIMEOUT;
            while cfg!(unix) && Instant::now() < deadline && service.child.try_wait().ok().flatten().is_none() {
                thread::sleep(Duration::from_millis(100));
            }
            let _ = service.child.kill();
            let _ = service.child.wait();
        }
        let _ = fs::remove_file(self.pid_file());
    }
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// KEY=VALUE lines, as scripts/db/postgres.mjs's parseEnv reads Mochi's .env.
fn parse_env(text: &str) -> Result<BTreeMap<String, String>, String> {
    let mut values = BTreeMap::new();
    for original in text.lines() {
        let line = original.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (name, value) = line.split_once('=').ok_or_else(|| format!("invalid line: {original}"))?;
        let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(format!("invalid line: {original}"));
        }
        let value = value.trim();
        let quoted = value.len() >= 2 && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')));
        values.insert(name.to_string(), if quoted { value[1..value.len() - 1].to_string() } else { value.to_string() });
    }
    Ok(values)
}

fn write_private(file: &Path, contents: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut handle = options.open(file).map_err(|error| format!("{}: {error}", file.display()))?;
    handle.write_all(contents.as_bytes()).map_err(|error| format!("{}: {error}", file.display()))
}

fn open_log(file: &Path) -> Result<fs::File, String> {
    fs::File::create(file).map_err(|error| format!("{}: {error}", file.display()))
}

fn open_log_append(file: &Path) -> Result<fs::File, String> {
    fs::OpenOptions::new().append(true).open(file).map_err(|error| format!("{}: {error}", file.display()))
}

fn tail(file: &Path) -> String {
    let text = fs::read_to_string(file).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    format!("{}:\n{}", file.display(), lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n"))
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

/// The plugin packages NanoAgent publishes: each folder with a manifest (as start-local.mjs finds them).
fn plugin_folders(root: &Path) -> Result<Vec<String>, String> {
    let mut folders: Vec<String> = fs::read_dir(root)
        .map_err(|error| format!("{}: {error}", root.display()))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join("nanoagent.yaml").is_file())
        .map(|path| path.display().to_string())
        .collect();
    folders.sort();
    Ok(folders)
}

/// True when anything accepts a connection on localhost:`port`.
fn listening(port: u16) -> bool {
    let Ok(addrs) = ("localhost", port).to_socket_addrs() else { return false };
    addrs.into_iter().any(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok())
}

/// `GET path` on localhost:`port`: the status code and body, or None when nothing answers.
fn http_get(port: u16, path: &str) -> Option<(u16, String)> {
    let addrs = ("localhost", port).to_socket_addrs().ok()?;
    for addr in addrs {
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(1)) else { continue };
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: localhost:{port}\r\n\r\n").as_bytes()).ok()?;
        let mut response = String::new();
        stream.read_to_string(&mut response).ok()?;
        let (head, body) = response.split_once("\r\n\r\n")?;
        let code = head.split_whitespace().nth(1)?.parse().ok()?;
        return Some((code, body.to_string()));
    }
    None
}

/// NanoAgent is ready when it identifies itself and its default profile can run
/// (the check start-local.mjs makes). An unavailable profile is a configuration error, not a wait.
fn nanoagent_ready(port: u16) -> Result<bool, String> {
    let Some((200, health)) = http_get(port, "/health") else { return Ok(false) };
    let health: serde_json::Value = serde_json::from_str(&health).map_err(|error| format!("NanoAgent /health: {error}"))?;
    if health["service"] != "nanoagent" {
        return Err("the service on NanoAgent's port is not NanoAgent".into());
    }
    let Some((200, catalog)) = http_get(port, "/v1/profiles") else { return Ok(false) };
    let catalog: serde_json::Value = serde_json::from_str(&catalog).map_err(|error| format!("NanoAgent /v1/profiles: {error}"))?;
    let default = &catalog["defaultProfile"];
    let profile = catalog["profiles"].as_array().and_then(|profiles| profiles.iter().find(|profile| &profile["id"] == default));
    let Some(profile) = profile else { return Err(format!("NanoAgent's default profile {default} is missing from its catalog")) };
    if profile["available"] == false {
        let reason = profile["unavailableReason"].as_str().unwrap_or("no reason given");
        return Err(format!("NanoAgent's default profile {default} is unavailable: {reason}"));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::parse_env;

    #[test]
    fn reads_env_lines_as_mochi_does() {
        let values = parse_env("# comment\n\nA=1\nexport B=\"two words\"\nC='x=y'\nD=\n").unwrap();
        assert_eq!(values["A"], "1");
        assert_eq!(values["B"], "two words");
        assert_eq!(values["C"], "x=y");
        assert_eq!(values["D"], "");
    }

    #[test]
    fn refuses_lines_that_are_not_assignments() {
        assert!(parse_env("A=1\nnot an assignment\n").is_err());
        assert!(parse_env("1A=1\n").is_err());
    }
}
