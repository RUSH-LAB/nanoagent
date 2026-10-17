//! Lends this computer to its member's runs on Mochi: NanoAgent and the relay that dials Mochi.
//!
//! The bundle (scripts/stage.mjs) carries NanoAgent, compiled, the relay (src/runner/relay.mjs),
//! Node, and uv. Each staging is installed once into the app's data folder, because NanoAgent's
//! .venv is made beside it. Startup runs `uv sync` for NanoAgent's dependencies, starts NanoAgent with
//! the member's API keys (none yet, on a first launch) and the plugins Mochi installs in this
//! platform's sandbox, waits for its default profile, and starts the relay. When the relay needs
//! signing in, the window shows Mochi's device page, where the member signs in to the site and
//! approves this computer: one sign-in serves the window and the relay. Once the relay is connected
//! the window opens the site, at Settings → AI while there is no key. The splash
//! (splash/index.html) polls `status` throughout; every failure shows there. Keys are set on the
//! keys page (splash/keys.html) or through the relay, from Settings → AI; either way the supervisor
//! keeps them, hands them to the running NanoAgent (PUT /v1/keys), and tells the relay which are
//! set.

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};

const NANOAGENT_TIMEOUT: Duration = Duration::from_secs(60);
// The member approves the relay's sign-in in their browser; Mochi's code outlives this.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);
const LOG_TAIL_LINES: usize = 30;
// What the services see of this process's environment; everything else comes from settings.
// The API keys Mochi Lab holds, by the name NanoAgent's PI runner (pi-ai) reads each from, and
// whose models they reach. NanoAgent gets these and nothing else of the settings.
pub const PROVIDER_KEYS: &[(&str, &str)] = &[
    ("OPENROUTER_API_KEY", "OpenRouter"),
    ("ANTHROPIC_API_KEY", "Anthropic"),
    ("OPENAI_API_KEY", "OpenAI"),
    ("GEMINI_API_KEY", "Google Gemini"),
    ("DEEPSEEK_API_KEY", "DeepSeek"),
    ("XAI_API_KEY", "xAI"),
    ("GROQ_API_KEY", "Groq"),
    ("MISTRAL_API_KEY", "Mistral"),
    ("CEREBRAS_API_KEY", "Cerebras"),
    ("TOGETHER_API_KEY", "Together AI"),
    ("FIREWORKS_API_KEY", "Fireworks"),
    ("MOONSHOT_API_KEY", "Moonshot"),
    ("ZAI_API_KEY", "Z.ai"),
    ("HF_TOKEN", "Hugging Face"),
];
const SYSTEM_ENV: &[&str] = &[
    "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR",
    "SystemRoot", "SystemDrive", "USERNAME", "USERDOMAIN", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "COMSPEC", "PATHEXT",
];

/// config.yaml, bundled by scripts/stage.mjs.
#[derive(Deserialize)]
pub struct Config {
    pub site_url: String,
    pub nanoagent_port: u16,
    pub python_version: String,
    pub files_folder: String,
}

/// One provider's key, as the keys page shows it: never its value, only its `hint`.
#[derive(Serialize)]
pub struct KeyStatus {
    env: &'static str,
    label: &'static str,
    set: bool,
    hint: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Status {
    /// starting | signin | failed | running
    phase: &'static str,
    message: String,
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
    /// The member's own files, kept in sync by the relay (src/runner/files.mjs): `files_folder` in their home.
    files: PathBuf,
    /// The folder holding the bundled node and uv: beside this executable.
    bin: PathBuf,
    splash: Mutex<Option<Url>>,
    status: Mutex<Status>,
    services: Mutex<Vec<Service>>,
    stopping: AtomicBool,
    /// The relay has reached Mochi since it started.
    connected: AtomicBool,
    /// Which start this is: a run or watch of an earlier one stands down.
    generation: AtomicU64,
    /// The running NanoAgent's bearer token, for handing it keys.
    nanoagent_token: Mutex<Option<String>>,
    /// The running relay's standard input: answers to its keys events, and which keys are set.
    relay_stdin: Mutex<Option<ChildStdin>>,
}

impl Supervisor {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
        let data = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
        let home = app.path().home_dir().map_err(|error| error.to_string())?;
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let config_file = resources.join("config.yaml");
        let text = fs::read_to_string(&config_file).map_err(|error| format!("{}: {error}", config_file.display()))?;
        let config: Config = serde_yaml::from_str(&text).map_err(|error| format!("{}: {error}", config_file.display()))?;
        Ok(Self {
            files: home.join(&config.files_folder),
            config,
            resources,
            data,
            bin: exe.parent().ok_or("the executable has no folder")?.to_path_buf(),
            splash: Mutex::new(None),
            status: Mutex::new(Status { phase: "starting", message: "Starting…".into() }),
            services: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            nanoagent_token: Mutex::new(None),
            relay_stdin: Mutex::new(None),
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
    fn stop_leftovers(&self) {
        let Ok(text) = fs::read_to_string(self.pid_file()) else { return };
        for (pid, program) in text.lines().filter_map(|line| line.split_once('\t')) {
            #[cfg(unix)]
            {
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
            // Windows has no signals: a recorded process still running the program it was started
            // with is killed with its tree, as the services are at quit.
            #[cfg(windows)]
            {
                let Some(image) = Path::new(program).file_name().and_then(|name| name.to_str()) else { continue };
                let filter = format!("PID eq {pid}");
                let listed = hidden(&mut Command::new("tasklist")).args(["/FI", &filter, "/FO", "CSV", "/NH"]).output();
                if listed.is_ok_and(|output| String::from_utf8_lossy(&output.stdout).to_lowercase().starts_with(&format!("\"{}\"", image.to_lowercase()))) {
                    kill_tree(pid);
                }
            }
        }
        let _ = fs::remove_file(self.pid_file());
    }

    /// Run startup on its own thread; the window's splash follows it through `status`.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        // The bundled page the window opened on, the first time.
        let mut splash = self.splash.lock().unwrap();
        if splash.is_none() {
            *splash = app.get_webview_window("main").and_then(|window| window.url().ok());
        }
        drop(splash);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.stopping.store(false, Ordering::SeqCst);
        self.connected.store(false, Ordering::SeqCst);
        self.set("starting", "Starting…");
        let supervisor = self.clone();
        thread::spawn(move || match supervisor.run(&app) {
            Ok(true) => supervisor.watch(&app, generation),
            Ok(false) => {}
            Err(message) if supervisor.generation.load(Ordering::SeqCst) == generation => supervisor.fail(&app, message),
            Err(_) => {}
        });
    }

    /// Each provider's key, set or not, and how it begins and ends.
    pub fn keys(&self) -> Vec<KeyStatus> {
        let settings = fs::read_to_string(self.settings_file()).ok().and_then(|text| parse_env(&text).ok()).unwrap_or_default();
        PROVIDER_KEYS
            .iter()
            .map(|&(env, label)| {
                let value = settings.get(env).filter(|value| !value.is_empty());
                KeyStatus { env, label, set: value.is_some(), hint: value.map(|value| key_hint(value)) }
            })
            .collect()
    }

    /// Set (a value) or remove (none) provider keys from the keys page: while Mochi Lab runs,
    /// straight into NanoAgent; after a failure, kept for the next start.
    pub fn save_keys(&self, changes: BTreeMap<String, Option<String>>) -> Result<(), String> {
        match self.status().phase {
            "running" => self.apply_keys(changes),
            "failed" => self.write_keys(changes),
            _ => Err("Mochi Lab is starting; save again once it has.".into()),
        }
    }

    /// Keep `changes`, hand them to the running NanoAgent, and tell the relay which keys are set
    /// now, so Settings → AI shows them.
    fn apply_keys(&self, changes: BTreeMap<String, Option<String>>) -> Result<(), String> {
        self.write_keys(changes.clone())?;
        let token = self.nanoagent_token.lock().unwrap().clone().ok_or("NanoAgent is not running")?;
        let body = serde_json::json!({ "changes": changes }).to_string();
        match http_request(self.config.nanoagent_port, "PUT", "/v1/keys", &token, Some(&body)) {
            Some((200, _)) => {}
            Some((status, body)) => return Err(format!("NanoAgent refused the keys ({status}): {body}")),
            None => return Err("NanoAgent did not answer".into()),
        }
        self.tell_relay(&serde_json::json!({ "keys": self.keys() }));
        Ok(())
    }

    /// One JSON line on the relay's standard input.
    fn tell_relay(&self, message: &serde_json::Value) {
        if let Some(stdin) = self.relay_stdin.lock().unwrap().as_mut() {
            let _ = writeln!(stdin, "{message}");
        }
    }

    /// Keep `changes` in the settings file, readable only by this user; an empty value is refused.
    fn write_keys(&self, changes: BTreeMap<String, Option<String>>) -> Result<(), String> {
        let mut keys: BTreeMap<String, String> = fs::read_to_string(self.settings_file())
            .ok()
            .and_then(|text| parse_env(&text).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|(name, _)| PROVIDER_KEYS.iter().any(|&(env, _)| env == name))
            .collect();
        for (name, value) in changes {
            if !PROVIDER_KEYS.iter().any(|&(env, _)| env == name) {
                return Err(format!("{name} is not a key Mochi Lab holds"));
            }
            match value.map(|value| value.trim().to_string()) {
                Some(value) if value.is_empty() || value.contains(char::is_whitespace) => {
                    return Err(format!("{name} must be one key, without spaces"));
                }
                Some(value) => keys.insert(name, value),
                None => keys.remove(&name),
            };
        }
        let contents: String = keys.iter().map(|(name, value)| format!("{name}={value}\n")).collect();
        fs::create_dir_all(&self.data).map_err(|error| error.to_string())?;
        write_private(&self.settings_file(), &contents)
    }

    /// Show the bundled `page` (keys.html, index.html) in the window.
    pub fn show(&self, app: &AppHandle, page: &str) {
        let splash = self.splash.lock().unwrap().clone();
        if let (Some(window), Some(url)) = (app.get_webview_window("main"), splash.and_then(|url| url.join(page).ok())) {
            let _ = window.navigate(url);
        }
    }

    /// Back to the site while Mochi Lab runs, else to its status.
    pub fn open_site(&self, app: &AppHandle) -> Result<(), String> {
        if self.status().phase != "running" {
            self.show(app, "index.html");
            return Ok(());
        }
        let site = Url::parse(&self.config.site_url).map_err(|error| error.to_string())?;
        if let Some(window) = app.get_webview_window("main") {
            window.navigate(site).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// Start again after a failure; refused while anything runs.
    pub fn restart(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        let phase = self.status().phase;
        if phase != "failed" {
            return Err(format!("Mochi Lab is {phase}"));
        }
        self.start(app);
        Ok(())
    }

    fn fail(&self, app: &AppHandle, message: String) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        self.stop_services();
        self.set("failed", message);
        self.show(app, "index.html");
    }

    /// Startup. Ok(false) when the app is quitting.
    fn run(self: &Arc<Self>, app: &AppHandle) -> Result<bool, String> {
        let settings_file = self.settings_file();
        let settings = match fs::read_to_string(&settings_file) {
            Ok(text) => parse_env(&text).map_err(|error| format!("{}: {error}", settings_file.display()))?,
            Err(_) => BTreeMap::new(),
        };
        let keys: BTreeMap<String, String> = PROVIDER_KEYS
            .iter()
            .filter_map(|&(env, _)| settings.get(env).filter(|value| !value.is_empty()).map(|value| (env.to_string(), value.clone())))
            .collect();
        let keyless = keys.is_empty();
        let sandbox = sandbox()?;

        self.stop_leftovers();
        let nanoagent_port = self.config.nanoagent_port;
        if listening(nanoagent_port) {
            return Err(format!("Port {nanoagent_port} already in use. Quit whatever is using it, then retry."));
        }

        let app_dir = self.install()?;
        let nanoagent = app_dir.join("nanoagent");
        let logs = self.data.join("logs");
        fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
        let system = self.environment();

        self.set("starting", "Preparing NanoAgent's Python environment (the first launch downloads Python)…");
        let uv_log = logs.join("uv-sync.log");
        // Only NanoAgent's dependencies, as the bundled uv.lock pins them: NanoAgent itself is the
        // compiled module in site/, with no source to check the lock against.
        let uv_status = hidden(&mut Command::new(self.bin.join(exe("uv"))))
            .args(["sync", "--frozen", "--no-dev", "--no-install-project", "--extra", "web", "--managed-python", "--python", &self.config.python_version])
            .current_dir(&nanoagent)
            .env_clear()
            .envs(&system)
            .stdin(Stdio::null())
            .stdout(open_log(&uv_log)?)
            .stderr(open_log_append(&uv_log)?)
            .status()
            .map_err(|error| format!("could not run uv: {error}"))?;
        if !uv_status.success() {
            return Err(format!("uv sync failed ({uv_status}).\n\n{}", tail(&uv_log)));
        }
        let site_packages = if cfg!(windows) {
            nanoagent.join(".venv/Lib/site-packages")
        } else {
            nanoagent.join(".venv/lib").join(format!("python{}", self.config.python_version)).join("site-packages")
        };
        fs::write(site_packages.join("nanoagent.pth"), format!("{}\n", nanoagent.join("site").display()))
            .map_err(|error| format!("could not add NanoAgent to its environment: {error}"))?;
        if self.stopping.load(Ordering::SeqCst) {
            return Ok(false);
        }

        self.set("starting", "Starting NanoAgent…");
        // Only the relay and the supervisor hold it, so nothing else on this computer can run NanoAgent.
        let token = random_token()?;
        let workspaces = self.data.join("agent-workspaces");
        let installs = self.data.join("nanoagent-installs");
        let uv_cache = self.data.join("nanoagent-uv-cache");
        let python = nanoagent.join(venv_python());
        let nanoagent_args = vec![
            // A compiled NanoAgent has no code object for `-m nanoagent` (nanoagent/__main__.py).
            "-I".to_string(), "-c".into(), "from nanoagent.__main__ import main; raise SystemExit(main())".into(), "web".into(),
            "web_cfg=deploy/railway/nanoagent.yaml".into(),
            "host=127.0.0.1".into(),
            format!("port={nanoagent_port}"),
            // Mochi's marketplace is anyone's, and this is the member's own computer: every plugin runs confined.
            format!("sandbox={sandbox}"),
            // The member's runs choose any model their keys reach, and settings of their own.
            "run_models=true".into(),
            format!("workspaces={}", serde_json::to_string(&workspaces.display().to_string()).unwrap()),
            format!("installs={}", serde_json::to_string(&installs.display().to_string()).unwrap()),
            format!("uv_cache={}", serde_json::to_string(&uv_cache.display().to_string()).unwrap()),
            // Plugins run on the Python NanoAgent runs on; its environment holds no PATH to find `python` on.
            format!("plugin_python={}", serde_json::to_string(&python.display().to_string()).unwrap()),
        ];
        // The keys are all NanoAgent is given of the settings.
        let mut nanoagent_env = system.clone();
        nanoagent_env.extend(keys);
        nanoagent_env.insert("NANOAGENT_API_TOKEN".into(), token.clone());
        let log = logs.join("nanoagent.log");
        self.spawn("NanoAgent", Command::new(&python).args(&nanoagent_args).current_dir(&nanoagent).env_clear().envs(&nanoagent_env), &log, false)?;
        if !self.wait_until("NanoAgent", NANOAGENT_TIMEOUT, || nanoagent_ready(nanoagent_port, &token))? {
            return Ok(false);
        }
        *self.nanoagent_token.lock().unwrap() = Some(token.clone());

        let site = self.config.site_url.clone();
        self.set("starting", format!("Connecting to {site}…"));
        let mut relay_env = system;
        relay_env.insert("MOCHI_SITE_URL".into(), site.clone());
        relay_env.insert("NANOAGENT_URL".into(), format!("http://127.0.0.1:{nanoagent_port}"));
        relay_env.insert("NANOAGENT_API_TOKEN".into(), token);
        relay_env.insert("RUNNER_CREDENTIALS".into(), self.data.join("runner-credentials.json").display().to_string());
        relay_env.insert("RUNNER_KEYS".into(), serde_json::to_string(&self.keys()).unwrap());
        relay_env.insert("RUNNER_FILES".into(), self.files.display().to_string());
        let relay = app_dir.join("runner");
        let log = logs.join("relay.log");
        let (stdin, stdout) = self
            .spawn(
                "The relay",
                Command::new(self.bin.join(exe("node"))).arg("relay.mjs").current_dir(&relay).env_clear().envs(&relay_env),
                &log,
                true,
            )?
            .expect("piped");
        *self.relay_stdin.lock().unwrap() = Some(stdin);
        self.follow_relay(app, stdout, log);
        if !self.wait_until("The relay", SIGN_IN_TIMEOUT, || Ok(self.connected.load(Ordering::SeqCst)))? {
            return Ok(false);
        }

        self.set("running", site.clone());
        // With no key yet, straight to where one is added.
        let page = if keyless { format!("{}/settings#ai", site.trim_end_matches('/')) } else { site };
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(Url::parse(&page).map_err(|error| format!("site_url {page}: {error}"))?);
        }
        Ok(true)
    }

    /// Read the relay's events (src/runner/relay.mjs) into its log and the status: show its
    /// sign-in page in the window, note when it is connected, and apply the keys Settings → AI
    /// sends, answering on its stdin. A keys event is never logged: it carries their values.
    fn follow_relay(self: &Arc<Self>, app: &AppHandle, stdout: ChildStdout, log: PathBuf) {
        let supervisor = self.clone();
        let app = app.clone();
        thread::spawn(move || {
            let Ok(mut file) = open_log_append(&log) else { return };
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let event = serde_json::from_str::<serde_json::Value>(&line).unwrap_or_default();
                if event["event"] != "keys" {
                    let _ = writeln!(file, "{line}");
                }
                match event["event"].as_str() {
                    Some("sign-in") => {
                        supervisor.set("signin", "Sign in to Mochi, then approve this computer.");
                        // The device page says it is Mochi Lab asking (src/pages/device).
                        let page = Url::parse(&format!("{}&client=desktop", event["url"].as_str().unwrap_or_default()));
                        if let (Some(window), Ok(page)) = (app.get_webview_window("main"), page) {
                            let _ = window.navigate(page);
                        }
                    }
                    Some("connected") => supervisor.connected.store(true, Ordering::SeqCst),
                    Some("keys") => {
                        let applied = serde_json::from_value(event["changes"].clone())
                            .map_err(|_| "changes must be {NAME: key or null}".to_string())
                            .and_then(|changes| supervisor.apply_keys(changes));
                        supervisor.tell_relay(&serde_json::json!({ "id": event["id"], "error": applied.err() }));
                    }
                    _ => {}
                }
            }
        });
    }

    /// Install this staging into data/app/<stamp> once, removing the others.
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
        for part in ["nanoagent", "runner"] {
            copy_dir(&self.resources.join(part), &partial.join(part)).map_err(|error| format!("installing {part}: {error}"))?;
        }
        for entry in fs::read_dir(&apps).map_err(|error| error.to_string())?.flatten() {
            let old = entry.path();
            if old != partial {
                fs::remove_dir_all(&old).map_err(|error| format!("removing {}: {error}", old.display()))?;
            }
        }
        fs::rename(&partial, &target).map_err(|error| error.to_string())?;
        Ok(target)
    }

    /// What every service sees: the system basics, and the bundled runtimes first on PATH
    /// (NanoAgent runs `node` for its PI runner and plugins run `uv`).
    fn environment(&self) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> = SYSTEM_ENV.iter().filter_map(|name| std::env::var(name).ok().map(|value| (name.to_string(), value))).collect();
        let system_path = if cfg!(windows) { std::env::var("PATH").unwrap_or_default() } else { "/usr/bin:/bin:/usr/sbin:/sbin".into() };
        let separator = if cfg!(windows) { ";" } else { ":" };
        // Windows: the git the app bundles (scripts/stage.mjs), the only one a plugin's sandbox can run.
        let git = if cfg!(windows) { format!("{}{separator}", self.resources.join("git").join("cmd").display()) } else { String::new() };
        env.insert("PATH".into(), format!("{}{separator}{git}{system_path}", self.bin.display()));
        env
    }

    /// Start `command`, its output in `log`; with `piped`, its standard input and output are the
    /// caller's to write and read instead.
    fn spawn(&self, name: &'static str, command: &mut Command, log: &Path, piped: bool) -> Result<Option<(ChildStdin, ChildStdout)>, String> {
        let program = command.get_program().to_string_lossy().into_owned();
        let mut child = hidden(command)
            .stdin(if piped { Stdio::piped() } else { Stdio::null() })
            .stdout(if piped { Stdio::piped() } else { open_log(log)?.into() })
            .stderr(if piped { open_log(log)? } else { open_log_append(log)? })
            .spawn()
            .map_err(|error| format!("could not start {name} ({program}): {error}"))?;
        let record = format!("{}\t{program}\n", child.id());
        fs::OpenOptions::new().create(true).append(true).open(self.pid_file())
            .and_then(|mut file| file.write_all(record.as_bytes()))
            .map_err(|error| format!("{}: {error}", self.pid_file().display()))?;
        let pipes = child.stdin.take().zip(child.stdout.take());
        self.services.lock().unwrap().push(Service { name, child, log: log.to_path_buf() });
        Ok(pipes)
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

    fn watch(&self, app: &AppHandle, generation: u64) {
        loop {
            if self.stopping.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst) != generation {
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

    /// The relay first, then NanoAgent: SIGTERM so each shuts down cleanly, SIGKILL after STOP_TIMEOUT.
    fn stop_services(&self) {
        *self.nanoagent_token.lock().unwrap() = None;
        *self.relay_stdin.lock().unwrap() = None;
        let mut services = self.services.lock().unwrap();
        while let Some(mut service) = services.pop() {
            if service.child.try_wait().ok().flatten().is_some() {
                continue;
            }
            #[cfg(unix)]
            unsafe {
                libc::kill(service.child.id() as libc::pid_t, libc::SIGTERM);
            }
            // A Python venv's python.exe starts the interpreter as its child: kill the whole tree.
            #[cfg(windows)]
            kill_tree(&service.child.id().to_string());
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

/// Kill the process `pid` and every process it started.
#[cfg(windows)]
fn kill_tree(pid: &str) {
    let _ = hidden(&mut Command::new("taskkill")).args(["/PID", pid, "/T", "/F"]).output();
}

/// `command` without a console window: this app has none, and each service would open one.
fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(command, 0x0800_0000);
    command
}

/// NanoAgent's Python inside its environment, relative to the environment's folder.
fn venv_python() -> &'static str {
    if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" }
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// The sandbox NanoAgent confines plugins in here (nanoagent.plugin.sandbox), which proves it
/// holds before it serves anything.
fn sandbox() -> Result<&'static str, String> {
    if cfg!(target_os = "macos") {
        Ok("seatbelt")
    } else if cfg!(target_os = "linux") {
        Ok("bwrap")
    } else if cfg!(windows) {
        Ok("appcontainer")
    } else {
        Err("Mochi Lab cannot confine plugins on this platform yet, so it does not run them here.".into())
    }
}

/// 32 random bytes, in hex.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("the system's random numbers: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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

/// True when anything accepts a connection on localhost:`port`.
fn listening(port: u16) -> bool {
    let Ok(addrs) = ("localhost", port).to_socket_addrs() else { return false };
    addrs.into_iter().any(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok())
}

/// `GET path` on localhost:`port` with NanoAgent's bearer `token`: the status code and body, or
/// None when nothing answers.
fn http_get(port: u16, path: &str, token: &str) -> Option<(u16, String)> {
    http_request(port, "GET", path, token, None)
}

/// `method path` on localhost:`port` with NanoAgent's bearer `token` and a JSON `body`.
fn http_request(port: u16, method: &str, path: &str, token: &str, body: Option<&str>) -> Option<(u16, String)> {
    let addrs = ("localhost", port).to_socket_addrs().ok()?;
    for addr in addrs {
        let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(1)) else { continue };
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
        let content = body.map(|body| format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())).unwrap_or_else(|| "\r\n".into());
        let request = format!("{method} {path} HTTP/1.0\r\nHost: localhost:{port}\r\nAuthorization: Bearer {token}\r\n{content}");
        stream.write_all(request.as_bytes()).ok()?;
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
fn nanoagent_ready(port: u16, token: &str) -> Result<bool, String> {
    let Some((200, health)) = http_get(port, "/health", token) else { return Ok(false) };
    let health: serde_json::Value = serde_json::from_str(&health).map_err(|error| format!("NanoAgent /health: {error}"))?;
    if health["service"] != "nanoagent" {
        return Err("the service on NanoAgent's port is not NanoAgent".into());
    }
    let Some((200, catalog)) = http_get(port, "/v1/profiles", token) else { return Ok(false) };
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

/// Enough of a key for its owner to tell which it is: its first six characters and its last four,
/// or only an ellipsis for a key too short to spare them.
fn key_hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 16 {
        return "…".into();
    }
    format!("{}…{}", chars[..6].iter().collect::<String>(), chars[chars.len() - 4..].iter().collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::{key_hint, parse_env};

    #[test]
    fn hints_at_a_key_without_giving_it_away() {
        assert_eq!(key_hint("sk-or-v1-0123456789abcdef"), "sk-or-…cdef");
        assert_eq!(key_hint("short-key"), "…");
    }

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
