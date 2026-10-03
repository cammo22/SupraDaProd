//! SupraDaProd — the heavy lifting (ONNX inference, audio, UI) happens in the
//! webview; Rust provides the native shell, real file storage, the save dialog
//! and the portable-mode plumbing.

mod export;
mod store;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let portable = store::detect_portable();

    // Portable build: keep the WebView2 profile (cache, localStorage…) next to the exe too,
    // so nothing is left behind on the host PC. Must be set before the webview exists.
    #[cfg(windows)]
    if let Some(dir) = &portable {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("webview"));
    }

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_dialog::init());
    }
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_android_fs::init());
    }

    builder
        .setup(move |app| {
            let (root, is_portable) = match portable.clone() {
                Some(dir) => (dir, true),
                None => {
                    // 0.x stored the gallery in the roaming app-data dir; keep using it if it's there.
                    let legacy = app.path().app_data_dir()?;
                    if legacy.join("gallery").join("index.json").exists() {
                        (legacy, false)
                    } else {
                        (app.path().app_local_data_dir()?, false)
                    }
                }
            };
            std::fs::create_dir_all(&root)?;
            app.manage(store::Store {
                root,
                portable: is_portable,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store::store_info,
            store::store_stat,
            store::store_read,
            store::store_write,
            store::store_write_b64,
            store::store_remove,
            store::store_rename,
            store::store_list,
            store::reveal_data_dir,
            export::export_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
