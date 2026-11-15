use crate::{storage::atomic_write, transaction_index};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::{fs, io::ErrorKind, path::Path, sync::Mutex, time::SystemTime};
use tauri::AppHandle;
use uuid::Uuid;

static LAST_STAMP: Mutex<i64> = Mutex::new(0);

thread_local! {
    static RECORD_REVISION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

pub fn record_revision() -> u64 {
    RECORD_REVISION.get()
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn filename_uuid(name: &str) -> Option<Uuid> {
    let (stamp, suffix) = name.strip_suffix(".json")?.split_at_checked(28)?;
    let uuid = Uuid::parse_str(suffix).ok()?;
    if uuid.to_string() != suffix {
        return None;
    }
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H-%M-%S%.6fZ-").ok()?;
    Some(uuid)
}

#[derive(Serialize)]
pub struct PendingTransaction {
    name: String,
    transaction: Option<Value>,
}

fn check_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_dir() || meta.is_symlink() => {
            Err("epi-i18n:diagnostic.invalidDataPath".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(message(error)),
    }
}

fn read_pending(root: &Path) -> Result<Vec<PendingTransaction>, String> {
    let directory = root.join("transactions");
    check_directory(&directory)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(message(error)),
    };
    let mut pending = Vec::new();
    for entry in entries {
        let entry = entry.map_err(message)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(uuid) = filename_uuid(&name) else {
            continue;
        };
        if !entry.file_type().map_err(message)?.is_file() {
            continue;
        }
        let contents = match fs::read_to_string(entry.path()) {
            Ok(contents) => contents,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => {
                pending.push(PendingTransaction {
                    name,
                    transaction: None,
                });
                continue;
            }
        };
        let transaction = serde_json::from_str::<Value>(contents.trim_start_matches('\u{feff}'))
            .ok()
            .filter(|value| value["uuid"].as_str() == Some(uuid.to_string().as_str()));
        pending.push(PendingTransaction { name, transaction });
    }
    pending.sort_unstable_by(|left, right| left.name.cmp(&right.name));
    Ok(pending)
}

#[tauri::command]
pub async fn pending_transactions(app: AppHandle) -> Result<Vec<PendingTransaction>, String> {
    tauri::async_runtime::spawn_blocking(move || read_pending(&crate::storage::data_root(&app)?))
        .await
        .map_err(message)?
}

#[tauri::command]
pub async fn archive_transactions(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::storage::data_root(&app)?;
        let pending = root.join("transactions");
        let sent = root.join("transactions.sent");
        check_directory(&pending)?;
        check_directory(&sent)?;
        fs::create_dir_all(&sent).map_err(message)?;
        for name in names {
            if filename_uuid(&name).is_none() {
                return Err("epi-i18n:diagnostic.invalidTransactionUuid".into());
            }
            let source = pending.join(&name);
            match fs::symlink_metadata(&source) {
                Ok(meta) if meta.is_file() => {}
                Ok(_) => continue,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(message(error)),
            }
            match fs::rename(source, sent.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(message(error)),
            }
        }
        Ok(())
    })
    .await
    .map_err(message)?
}

pub fn change(
    root: &Path,
    path: &Path,
    existed: bool,
    value: Option<&Value>,
) -> Result<Value, String> {
    let relative = path.strip_prefix(root).map_err(message)?;
    let path = relative
        .iter()
        .map(|part| part.to_str().ok_or("epi-i18n:diagnostic.invalidDataPath2"))
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    Ok(match value {
        Some(value) => {
            json!({"type": if existed { "update" } else { "create" }, "path": path, "value": value})
        }
        None => json!({"type": "delete", "path": path}),
    })
}

pub fn record(root: &Path, operations: Vec<Value>) -> Result<(), String> {
    if operations.is_empty() {
        return Ok(());
    }
    let mut last_stamp = LAST_STAMP.lock().map_err(message)?;
    let now = DateTime::<Utc>::from(SystemTime::now()).timestamp_micros();
    *last_stamp = now.max(*last_stamp + 1);
    let stamp = DateTime::from_timestamp_micros(*last_stamp)
        .ok_or("epi-i18n:diagnostic.invalidTransactionDate")?
        .to_rfc3339_opts(SecondsFormat::Micros, true)
        .replace(':', "-");
    let uuid = Uuid::new_v4();
    let transaction = if operations.len() == 1 {
        let mut data = operations.into_iter().next().unwrap();
        let kind = data.as_object_mut().unwrap().remove("type").unwrap();
        json!({"uuid": uuid.to_string(), "type": kind, "data": data})
    } else {
        json!({"uuid": uuid.to_string(), "type": "batch", "data": operations})
    };
    let path = root
        .join("transactions")
        .join(format!("{stamp}-{uuid}.json"));
    let mut bytes = serde_json::to_vec_pretty(&transaction).map_err(message)?;
    bytes.push(b'\n');
    if !atomic_write(&path, &bytes, false)? {
        return Err("epi-i18n:diagnostic.aTransactionFileAlreadyExists".into());
    }
    if let Err(error) = transaction_index::add(root, uuid) {
        fs::remove_file(path).map_err(|cleanup| format!("{error} · {cleanup}"))?;
        return Err(message(error));
    }
    RECORD_REVISION.set(record_revision().wrapping_add(1));
    Ok(())
}
