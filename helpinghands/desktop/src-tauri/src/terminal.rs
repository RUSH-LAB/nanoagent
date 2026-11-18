//! The window's link to a Harness tab session's terminals, which run on this computer: the member's worker serves them on
//! 127.0.0.1 (nanoagent/uploaded/terminal.py), and the site's page, served over https, may not open a connection there itself
//! (WebKit refuses it as mixed content). So the page asks the app: `terminal_link` connects to the port RUSH named with the token RUSH
//! handed the session's member, and hands each line the worker sends to the page's channel, the last `{"ended"}` (null, or why it
//! broke); `terminal_send` sends the worker a line; `terminal_unlink` closes the link, as a page that reloads or leaves closes all of
//! its window's (`unlink_all`). Only the window's own site may call them (main.rs). RUSH is on neither way.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// The window's open links, by id.
#[derive(Default)]
pub struct Links {
    next: AtomicU32,
    open: Mutex<HashMap<u32, TcpStream>>,
}

/// Link the page to the terminals the worker serves on 127.0.0.1:`port`, with `token`: the link's id.
#[tauri::command(async)]
pub fn terminal_link(app: AppHandle, links: State<'_, Links>, port: u16, token: String, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let unreachable = |error: std::io::Error| format!("Could not reach the session's terminals on this computer (127.0.0.1:{port}): {error}");
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(unreachable)?;
    stream.set_nodelay(true).map_err(unreachable)?;
    stream.write_all(format!("{}\n", json!({"token": token})).as_bytes()).map_err(unreachable)?;
    let reader = stream.try_clone().map_err(unreachable)?;
    let link = links.next.fetch_add(1, Ordering::Relaxed);
    links.open.lock().unwrap().insert(link, stream);
    thread::spawn(move || {
        let mut lines = BufReader::new(reader);
        let mut line = String::new();
        let broke = loop {
            line.clear();
            match lines.read_line(&mut line) {
                Ok(0) => break None,
                Ok(_) => {
                    if events.send(InvokeResponseBody::Json(line.trim_end().to_owned())).is_err() {
                        break None;
                    }
                }
                Err(error) => break Some(error.to_string()),
            }
        };
        // A link the page closed ended as it asked, whatever the socket said.
        let ours = app.state::<Links>().open.lock().unwrap().remove(&link).is_some();
        let ended = if ours { broke.map_or(Value::Null, Value::String) } else { Value::Null };
        let _ = events.send(InvokeResponseBody::Json(json!({"ended": ended}).to_string()));
    });
    Ok(link)
}

/// Send the worker `line` over link `link`.
#[tauri::command(async)]
pub fn terminal_send(links: State<'_, Links>, link: u32, line: String) -> Result<(), String> {
    let open = links.open.lock().unwrap();
    let mut stream = open.get(&link).ok_or("The link to the session's terminals is closed")?;
    stream.write_all(format!("{line}\n").as_bytes()).map_err(|error| format!("The link to the session's terminals broke: {error}"))
}

/// Close link `link`.
#[tauri::command(async)]
pub fn terminal_unlink(links: State<'_, Links>, link: u32) {
    if let Some(stream) = links.open.lock().unwrap().remove(&link) {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

/// Close every link: the page that made them is gone.
pub fn unlink_all(links: &Links) {
    for (_, stream) in links.open.lock().unwrap().drain() {
        let _ = stream.shutdown(Shutdown::Both);
    }
}
