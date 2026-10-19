//! RUSH Lab's engine: what the app runs (lab.mjs, the relay and NanoAgent, scripts/engine.mjs),
//! one archive for every target, apart from the app around it, its shell. The app is built with one
//! engine and keeps the newest its site serves for its shell (GET /api/lab/engine,
//! server/routes/lab.js): at its start, before lab.mjs runs, and every CHECK_EVERY after, when it
//! switches to it once nothing runs here (lab.rs). An engine is taken only when its archive's
//! sha256 is the one the site names and its signature checks out against the app's update key
//! (plugins.updater.pubkey in tauri.conf.json), the key its updates are signed with.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Url};

use crate::lab::Lab;

const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// How long the check at the app's start may take, before lab.mjs runs the engine it has.
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// How long downloading an engine may take.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const IDLE_POLL: Duration = Duration::from_secs(30);

/// What the site says of the engine it serves.
#[derive(Deserialize)]
struct Served {
    stamp: String,
    shell: String,
    sha256: String,
    signature: String,
    url: String,
}

/// The app's update key, which every engine is signed with.
fn update_key(app: &AppHandle) -> Result<String, String> {
    let updater = app.config().plugins.0.get("updater").ok_or("tauri.conf.json has no updater")?;
    updater.get("pubkey").and_then(|key| key.as_str()).map(str::to_string).ok_or_else(|| "tauri.conf.json's updater has no pubkey".to_string())
}

/// A client for the site, on the TLS the updater uses (rustls with ring), which it installs as the
/// process's when nothing has yet.
fn client() -> reqwest::Client {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Fails only when another thread has just installed one, which serves as well.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::new()
}

/// The engine `site` serves, when it is for `lab`'s shell and newer than the one it runs.
async fn newer(lab: &Lab, site: &Url, timeout: Duration) -> Result<Option<Served>, String> {
    let mut endpoint = site.clone();
    endpoint.set_path("/api/lab/engine");
    let response = client().get(endpoint).timeout(timeout).send().await.map_err(|error| error.to_string())?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("the site answered {}", response.status()));
    }
    let served: Served = response.json().await.map_err(|error| error.to_string())?;
    Ok((served.shell == lab.shell && served.stamp.as_str() > lab.stamp().as_str()).then_some(served))
}

/// Download `served`, check it, and install it beside the engine `lab` runs: its folder.
async fn fetch(app: &AppHandle, lab: &Lab, served: &Served) -> Result<PathBuf, String> {
    let archive = client()
        .get(&served.url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?
        .bytes()
        .await
        .map_err(|error| error.to_string())?;
    let sha256 = format!("{:x}", Sha256::digest(&archive));
    if sha256 != served.sha256 {
        return Err(format!("its archive's sha256 is {sha256}, not the {} the site names", served.sha256));
    }
    verify(&archive, &served.signature, &update_key(app)?)?;
    let partial = lab.apps().join(format!("{}.partial", served.stamp));
    let _ = fs::remove_dir_all(&partial);
    let root = partial.join("mochi-lab");
    unpack(&archive, &root)?;
    // What it says of itself must be what the site said of it.
    for (file, expected) in [("stamp", &served.stamp), ("shell", &served.shell)] {
        let said = fs::read_to_string(root.join(file)).map_err(|error| format!("its {file}: {error}"))?;
        if said.trim() != expected {
            return Err(format!("its {file} is {}, not the {expected} the site names", said.trim()));
        }
    }
    lab.add_shell(&root)?;
    let installed = lab.apps().join(&served.stamp);
    fs::rename(&partial, &installed).map_err(|error| error.to_string())?;
    Ok(installed.join("mochi-lab"))
}

/// Whether `signature` (a .sig, base64) is `key`'s (base64, as tauri.conf.json holds it) for `data`.
fn verify(data: &[u8], signature: &str, key: &str) -> Result<(), String> {
    let decode = |text: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(text).map_err(|error| error.to_string())?;
        String::from_utf8(bytes).map_err(|error| error.to_string())
    };
    let key = PublicKey::decode(&decode(key)?).map_err(|error| format!("the update key: {error}"))?;
    let signature = Signature::decode(&decode(signature)?).map_err(|error| format!("its signature: {error}"))?;
    key.verify(data, &signature, true).map_err(|error| format!("its signature is not the update key's: {error}"))
}

/// Unpack the gzipped tar `archive` into `to`, refusing any entry that would land outside it.
fn unpack(archive: &[u8], to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    let mut entries = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in entries.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        if !entry.unpack_in(to).map_err(|error| error.to_string())? {
            return Err(format!("its archive has {}, outside its folder", entry.path().map_err(|error| error.to_string())?.display()));
        }
    }
    Ok(())
}

/// At the app's start, before lab.mjs runs: install the newer engine `site` serves for this shell,
/// if there is one, and run it. When the site cannot say in START_TIMEOUT, lab.mjs runs the engine
/// it has, and the check every CHECK_EVERY carries on.
pub fn take_at_start(app: &AppHandle, lab: &Lab, site: &Url) {
    match tauri::async_runtime::block_on(async {
        match newer(lab, site, START_TIMEOUT).await? {
            Some(served) => fetch(app, lab, &served).await.map(Some),
            None => Ok(None),
        }
    }) {
        Ok(Some(root)) => {
            lab.log(&format!("Installed the engine {}.", lab.stamp_of(&root)));
            lab.run_from(root);
        }
        Ok(None) => {}
        Err(message) => lab.log(&format!("Could not take the engine {site} serves: {message}")),
    }
}

/// Every CHECK_EVERY, install the newer engine `site` serves for this shell, if there is one, and
/// switch to it once nothing runs here.
pub fn keep_current(app: AppHandle, lab: Arc<Lab>, site: Url) {
    thread::spawn(move || loop {
        thread::sleep(CHECK_EVERY);
        let fetched = tauri::async_runtime::block_on(async {
            match newer(&lab, &site, DOWNLOAD_TIMEOUT).await? {
                Some(served) => fetch(&app, &lab, &served).await.map(Some),
                None => Ok(None),
            }
        });
        match fetched {
            Ok(Some(root)) => {
                while !lab.idle() {
                    thread::sleep(IDLE_POLL);
                }
                lab.log(&format!("Switching to the engine {}.", lab.stamp_of(&root)));
                lab.switch(root);
            }
            Ok(None) => {}
            Err(message) => lab.log(&format!("Could not take the engine {site} serves: {message}")),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // A key made for these tests alone, and its signature of b"engine".
    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDMzQkNCQkY3QjhFMDYyN0UKUldSK1l1QzQ5N3U4TTZrSE8vUnZ1QXp0YTVjeG9ONloxZk4yNGJCVVZwTFNYMHNuak4rMUxmNXoK";
    const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSK1l1QzQ5N3U4TXgrMkE3RXM5Qmpsbi9LZHVTaVgwRmlKYlQwandlT0JXeXlHYmVncFkycTlzTG9uOFBjVVAwanpDVHc2REVZaHQ0L3B3MEpLNXFZKzUwTnlIQ3FyRndNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNDA5NTc0CWZpbGU6ZGF0YQpOY0d0WkEwUlU0MHpHbkZqdWVqQkNBUkxlWktFR3kxTFpwazVweXVkdW5BOUFxUkQvVHZwSDRBWUVrZkIvcUV3SXAvYlYxT3pvTzZvTVhkUk9jR0dEZz09Cg==";

    #[test]
    fn takes_only_what_the_key_signed() {
        assert!(verify(b"engine", SIGNATURE, KEY).is_ok());
        assert!(verify(b"engines", SIGNATURE, KEY).is_err());
        assert!(verify(b"engine", "not base64", KEY).is_err());
    }

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            // Written as it stands, so a path that climbs out is kept as one.
            header.as_gnu_mut().unwrap().name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn unpacks_inside_its_folder_only() {
        let folder = std::env::temp_dir().join(format!("rush-lab-engine-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        unpack(&archive(&[("runner/lab.mjs", b"lab"), ("stamp", b"s\n")]), &folder.join("in")).unwrap();
        assert_eq!(fs::read(folder.join("in/runner/lab.mjs")).unwrap(), b"lab");
        assert!(unpack(&archive(&[("../out", b"x")]), &folder.join("climb")).is_err());
        assert!(!folder.join("out").exists());
        fs::remove_dir_all(&folder).unwrap();
    }
}
