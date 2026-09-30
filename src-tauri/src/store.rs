//! File storage for models and the gallery.
//!
//! The webview never gets raw filesystem access: it talks to these commands, and
//! every path is a *relative* path that is validated and resolved under one root
//! directory (app data, or the `SupraDaProd-data` folder next to the exe in
//! portable mode). Commands are `async` so disk I/O never blocks the UI thread.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

pub struct Store {
    pub root: PathBuf,
    pub portable: bool,
}

/// Resolves a relative, forward-slash path under `root`, rejecting anything that could escape it.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    let mut out = root.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(n) => out.push(n),
            Component::CurDir => {}
            _ => return Err(format!("invalid path: {rel}")),
        }
    }
    Ok(out)
}

fn io<T>(r: std::io::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    root: String,
    portable: bool,
}

#[derive(Serialize)]
pub struct Stat {
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    size: u64,
    is_dir: bool,
}

#[tauri::command]
pub async fn store_info(state: State<'_, Store>) -> Result<Info, String> {
    Ok(Info {
        root: state.root.display().to_string(),
        portable: state.portable,
    })
}

#[tauri::command]
pub async fn store_stat(state: State<'_, Store>, path: String) -> Result<Option<Stat>, String> {
    let p = resolve(&state.root, &path)?;
    match fs::metadata(&p) {
        Ok(m) if m.is_file() => Ok(Some(Stat { size: m.len() })),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn store_read(
    state: State<'_, Store>,
    path: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    let p = resolve(&state.root, &path)?;
    let mut f = io(File::open(&p))?;
    io(f.seek(SeekFrom::Start(offset)))?;
    let mut buf = Vec::new();
    io(f.take(length).read_to_end(&mut buf))?;
    Ok(Response::new(buf))
}

/// Raw-body command: the bytes are the request body, `x-path` / `x-append` are headers.
#[tauri::command]
pub async fn store_write(state: State<'_, Store>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected a raw binary body".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let rel = header("x-path").ok_or("missing x-path header")?;
    let rel = percent_decode_str(&rel)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let append = header("x-append").as_deref() == Some("1");
    let p = resolve(&state.root, &rel)?;
    if let Some(parent) = p.parent() {
        io(fs::create_dir_all(parent))?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true);
    if append {
        opts.append(true);
    } else {
        opts.write(true).truncate(true);
    }
    let mut f = io(opts.open(&p))?;
    io(f.write_all(data))?;
    Ok(())
}

#[tauri::command]
pub async fn store_remove(state: State<'_, Store>, path: String) -> Result<(), String> {
    let p = resolve(&state.root, &path)?;
    if p == state.root {
        return Err("refusing to remove the storage root".into());
    }
    match fs::metadata(&p) {
        Ok(m) if m.is_dir() => io(fs::remove_dir_all(&p)),
        Ok(_) => io(fs::remove_file(&p)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn store_rename(state: State<'_, Store>, from: String, to: String) -> Result<(), String> {
    let a = resolve(&state.root, &from)?;
    let b = resolve(&state.root, &to)?;
    if let Some(parent) = b.parent() {
        io(fs::create_dir_all(parent))?;
    }
    io(fs::rename(a, b))
}

#[tauri::command]
pub async fn store_list(state: State<'_, Store>, path: String) -> Result<Vec<Entry>, String> {
    let p = resolve(&state.root, &path)?;
    let rd = match fs::read_dir(&p) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if let Ok(m) = e.metadata() {
            out.push(Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                size: if m.is_file() { m.len() } else { 0 },
                is_dir: m.is_dir(),
            });
        }
    }
    Ok(out)
}

/// Opens the data folder in the system file manager (desktop only).
#[tauri::command]
pub async fn reveal_data_dir(state: State<'_, Store>) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let opener = if cfg!(target_os = "windows") {
            "explorer"
        } else if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        io(std::process::Command::new(opener).arg(&state.root).spawn())?;
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = state;
    Ok(())
}

/// Portable mode: the exe is called `*portable*.exe`, or sits next to a `portable.flag`
/// file / an existing `SupraDaProd-data` folder. Everything — models, gallery, even the
/// WebView2 profile — then lives in `SupraDaProd-data` beside the exe.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn detect_portable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let stem = exe.file_stem()?.to_string_lossy().to_lowercase();
    let data = dir.join("SupraDaProd-data");
    let flagged = stem.contains("portable") || dir.join("portable.flag").exists() || data.is_dir();
    if !flagged {
        return None;
    }
    // Only if the folder is actually writable (e.g. not inside Program Files).
    fs::create_dir_all(&data).ok()?;
    let probe = data.join(".write-test");
    File::create(&probe).ok()?;
    let _ = fs::remove_file(probe);
    Some(data)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn detect_portable() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_inside_root() {
        let root = Path::new("/data");
        assert_eq!(
            resolve(root, "models/a/b.onnx").unwrap(),
            root.join("models").join("a").join("b.onnx")
        );
        assert_eq!(resolve(root, "").unwrap(), root);
    }

    #[test]
    fn rejects_escapes() {
        let root = Path::new("/data");
        assert!(resolve(root, "../etc/passwd").is_err());
        assert!(resolve(root, "a/../../b").is_err());
        assert!(resolve(root, "/abs").is_err());
    }
}
