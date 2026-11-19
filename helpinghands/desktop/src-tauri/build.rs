fn main() {
    // The app's own commands (terminal.rs), each allowed only where main.rs grants it: to the window's own site.
    let commands = tauri_build::AppManifest::new().commands(&["terminal_link", "terminal_send", "terminal_unlink"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands)).expect("the app's build failed");
}
