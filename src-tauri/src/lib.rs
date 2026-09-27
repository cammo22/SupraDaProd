// SupraDaProd — all heavy lifting (ONNX inference, audio, storage) happens in
// the webview, so the Rust side stays a thin shell. Light by design.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
