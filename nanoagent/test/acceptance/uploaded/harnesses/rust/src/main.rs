// A harness with zero model calls: computes the probe's digest locally and writes the result atomically.
use sha2::{Digest, Sha256};
use std::{env, fs};

fn main() {
    let request: serde_json::Value =
        serde_json::from_slice(&fs::read(env::var("RUSH_REQUEST").unwrap()).unwrap()).unwrap();
    let token = request["case"]["arguments"]["token"].as_str().unwrap();
    let hash = Sha256::digest(token.as_bytes());
    let digest: String = hash.iter().take(6).map(|byte| format!("{byte:02x}")).collect();
    let result = serde_json::json!({"protocol": "rush.harness.v1", "status": "answered", "answer": {"digest": digest}});
    let target = env::var("RUSH_RESULT").unwrap();
    let temporary = format!("{target}.tmp");
    fs::write(&temporary, result.to_string()).unwrap();
    fs::rename(&temporary, &target).unwrap();
}
