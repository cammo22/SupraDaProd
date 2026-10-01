//! Getting an image out of the app.
//!  • desktop: native "Save as…" dialog
//!  • Android: straight into the Pictures gallery (MediaStore), no permission prompt on Android 10+

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request};

#[tauri::command]
pub async fn export_image(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw binary body".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
        .unwrap_or_else(|| "supradaprod.png".into());
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || "-_. ".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    save(app, name, bytes.clone()).await
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn save(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter("PNG", &["png"])
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[cfg(target_os = "android")]
async fn save(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_android_fs::{AndroidFsExt, PublicImageDir};
    let api = app.android_fs_async();
    let storage = api.public_storage();
    if !storage
        .request_permission()
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("storage permission denied".into());
    }
    storage
        .write_new(
            None,
            PublicImageDir::Pictures,
            format!("SupraDaProd/{name}"),
            Some("image/png"),
            &bytes,
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(format!("Pictures/SupraDaProd/{name}")))
}

#[cfg(target_os = "ios")]
async fn save(
    _app: tauri::AppHandle,
    _name: String,
    _bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    Err("export is not supported on iOS yet".into())
}
