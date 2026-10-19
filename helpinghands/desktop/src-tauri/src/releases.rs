//! What RUSH Lab's site serves, as it serves it: GET /api/lab/releases (server/routes/lab.js), a
//! stream the app keeps open of its own, apart from the relay, so a broken engine never keeps it
//! from hearing of the one that fixes it. The site says the engine it serves and each target's
//! update when the stream opens and as each is uploaded; the engine goes to engine.rs, this
//! target's update to update.rs. A stream that ends, or is silent past SILENT, as one is after the
//! computer slept, is opened again after RECONNECT, and says what the site serves again.

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::Url;

use crate::engine;
use crate::lab::Lab;

const RECONNECT: Duration = Duration::from_secs(10);
/// The site writes at least every 25s, its heartbeat.
const SILENT: Duration = Duration::from_secs(60);

/// What the site serves: its engine's stamp, and each target's update's version.
#[derive(Deserialize)]
struct Release {
    engine: Option<String>,
    updates: HashMap<String, Option<String>>,
}

/// Follow what `site` serves: each engine it names to `engines`, and each version of `update`'s
/// target (a release's; None for any other build) to its sender.
pub fn follow(lab: Arc<Lab>, site: Url, engines: Sender<String>, update: Option<(String, Sender<String>)>) {
    thread::spawn(move || loop {
        let ended = tauri::async_runtime::block_on(read(&site, |release| {
            if let Some(stamp) = release.engine {
                let _ = engines.send(stamp);
            }
            if let Some((target, versions)) = &update {
                if let Some(Some(version)) = release.updates.get(target) {
                    let _ = versions.send(version.clone());
                }
            }
        }));
        lab.log(&format!("What {site} serves stopped streaming ({}); opening it again in {}s.", ended.err().unwrap_or_else(|| "it ended".into()), RECONNECT.as_secs()));
        thread::sleep(RECONNECT);
    });
}

/// Read the stream until it ends, handing `on` each release it says.
async fn read(site: &Url, mut on: impl FnMut(Release)) -> Result<(), String> {
    let mut endpoint = site.clone();
    endpoint.set_path("/api/lab/releases");
    let client = engine::client().read_timeout(SILENT).build().map_err(|error| error.to_string())?;
    let mut response = client.get(endpoint).send().await.and_then(|response| response.error_for_status()).map_err(|error| error.to_string())?;
    let mut buffer = String::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        for release in take_releases(&mut buffer)? {
            on(release);
        }
    }
    Ok(())
}

/// The releases of each whole event at the start of `buffer`, which keeps what follows them.
fn take_releases(buffer: &mut String) -> Result<Vec<Release>, String> {
    let mut releases = Vec::new();
    while let Some(end) = buffer.find("\n\n") {
        let event: String = buffer.drain(..end + 2).collect();
        // A heartbeat is a comment, and says nothing.
        if let Some(data) = event.lines().find_map(|line| line.strip_prefix("data: ")) {
            releases.push(serde_json::from_str(data).map_err(|error| format!("a release the site said: {error}"))?);
        }
    }
    Ok(releases)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_whole_event_and_keeps_the_rest() {
        let mut buffer = String::from("event: release\ndata: {\"engine\":\"e1\",\"updates\":{\"t\":\"1.0.0\",\"u\":null}}\n\n: heartbeat\n\nevent: release\ndata: {\"engine\":null,");
        let releases = take_releases(&mut buffer).unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].engine.as_deref(), Some("e1"));
        assert_eq!(releases[0].updates["t"].as_deref(), Some("1.0.0"));
        assert_eq!(releases[0].updates["u"], None);
        assert_eq!(buffer, "event: release\ndata: {\"engine\":null,");
        buffer.push_str("\"updates\":{}}\n\n");
        let releases = take_releases(&mut buffer).unwrap();
        assert_eq!(releases[0].engine, None);
        assert!(buffer.is_empty());
    }
}
