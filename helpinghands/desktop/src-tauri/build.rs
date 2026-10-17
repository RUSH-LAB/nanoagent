use tauri_build::{AppManifest, Attributes};

fn main() {
    // The app's own commands, the terminal's (src/terminal.rs), which only capabilities/terminal.json grants.
    let commands = &["terminal_projects", "terminal_new_project", "terminal_open_project", "terminal_start", "terminal_write", "terminal_resize"];
    tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(commands))).expect("failed to build the app's manifest");
}
