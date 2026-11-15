use crate::{
    storage::{atomic_write, read_bytes, restore_file, valid_transaction_path},
    transaction_index,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};
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

#[derive(Serialize)]
pub struct IntegratedTransactions {
    uuids: Vec<Uuid>,
    changed: bool,
}

fn local_ids(root: &Path) -> Result<HashSet<Uuid>, String> {
    let index = root.join("transactions.index");
    if fs::symlink_metadata(index).is_ok_and(|meta| !meta.is_file() || meta.is_symlink()) {
        return Err("epi-i18n:diagnostic.invalidDataPath".into());
    }
    let mut ids = transaction_index::load(root).map_err(message)?;
    for folder in ["transactions", "transactions.sent"] {
        let directory = root.join(folder);
        check_directory(&directory)?;
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(message(error)),
        };
        for entry in entries {
            let entry = entry.map_err(message)?;
            if entry.file_type().map_err(message)?.is_file() {
                ids.extend(filename_uuid(&entry.file_name().to_string_lossy()));
            }
        }
    }
    Ok(ids)
}

struct FileChange {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}

fn transaction_changes(root: &Path, transaction: &Value) -> Result<Vec<FileChange>, String> {
    let invalid = || "epi-i18n:diagnostic.invalidDataPath".to_owned();
    let kind = transaction["type"].as_str().ok_or_else(invalid)?;
    let data = &transaction["data"];
    let operations: &[Value] = if kind == "batch" {
        data.as_array()
            .filter(|rows| !rows.is_empty())
            .ok_or_else(invalid)?
    } else {
        std::slice::from_ref(data)
    };
    let mut paths = HashSet::new();
    operations
        .iter()
        .map(|operation| {
            let relative = operation["path"]
                .as_str()
                .filter(|path| valid_transaction_path(path) && paths.insert(path.to_lowercase()))
                .ok_or_else(invalid)?;
            let mut path = root.to_owned();
            let mut components = relative.split('/').peekable();
            while let Some(part) = components.next() {
                path.push(part);
                if components.peek().is_some() {
                    check_directory(&path)?;
                } else if fs::symlink_metadata(&path)
                    .is_ok_and(|meta| !meta.is_file() || meta.is_symlink())
                {
                    return Err(invalid());
                }
            }
            let op = if kind == "batch" {
                operation["type"].as_str()
            } else {
                Some(kind)
            };
            let after = match (op, operation.get("value")) {
                (Some("create" | "update"), Some(value)) => {
                    let mut bytes = serde_json::to_vec_pretty(value).map_err(message)?;
                    bytes.push(b'\n');
                    Some(bytes)
                }
                (Some("delete"), None) => None,
                _ => return Err(invalid()),
            };
            Ok(FileChange {
                before: read_bytes(&path)?,
                path,
                after,
            })
        })
        .collect()
}

fn apply_received(root: &Path, uuid: Uuid, name: &str, transaction: &Value) -> Result<(), String> {
    let mut archive = transaction.clone();
    archive
        .as_object_mut()
        .ok_or("epi-i18n:diagnostic.invalidDataPath")?
        .remove("name");
    let mut bytes = serde_json::to_vec_pretty(&archive).map_err(message)?;
    bytes.push(b'\n');
    let destination = root.join("transactions.sent").join(name);
    let mut changes = transaction_changes(root, transaction)?;
    changes.push(FileChange {
        path: destination,
        before: None,
        after: Some(bytes),
    });
    let mut applied = Vec::new();
    let result = (|| {
        for change in &changes {
            if change.before == change.after {
                continue;
            }
            let path = &change.path;
            if read_bytes(path)? != change.before {
                return Err("epi-i18n:diagnostic.invalidDataPath".into());
            }
            if let Some(after) = &change.after {
                if !atomic_write(path, after, change.before.is_some())? {
                    return Err("epi-i18n:diagnostic.aTransactionFileAlreadyExists".into());
                }
            } else {
                fs::remove_file(path).map_err(message)?;
            }
            applied.push(change);
        }
        transaction_index::add(root, uuid).map_err(message)
    })();
    if result.is_err() {
        for change in applied.into_iter().rev() {
            if read_bytes(&change.path).ok().as_ref() == Some(&change.after) {
                let _ = restore_file(&change.path, change.before.as_deref());
            }
        }
    }
    result
}

fn integrate(root: &Path, rows: Vec<Value>) -> Result<IntegratedTransactions, String> {
    let mut ids = local_ids(root)?;
    let mut acknowledged = HashSet::new();
    let mut result = IntegratedTransactions {
        uuids: Vec::new(),
        changed: false,
    };
    for transaction in rows {
        let Some(uuid) = transaction["uuid"].as_str().and_then(|id| {
            Uuid::parse_str(id)
                .ok()
                .filter(|uuid| uuid.to_string() == id)
        }) else {
            continue;
        };
        if !ids.contains(&uuid) {
            let Some(name) = transaction["name"]
                .as_str()
                .filter(|name| filename_uuid(name) == Some(uuid))
            else {
                continue;
            };
            if apply_received(root, uuid, name, &transaction).is_err() {
                continue;
            }
            ids.insert(uuid);
            result.changed = true;
        }
        if acknowledged.insert(uuid) {
            result.uuids.push(uuid);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn integrate_transactions(
    app: AppHandle,
    transactions: Vec<Value>,
) -> Result<IntegratedTransactions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        integrate(&crate::storage::data_root(&app)?, transactions)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn received_transactions_archive_successes_and_acknowledge_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let uuid = Uuid::new_v4();
        let name = format!("2026-01-15T17-23-21.000001Z-{uuid}.json");
        let row = json!({"uuid":uuid.to_string(), "name": name, "type":"update",
            "data":{"path":"profiles/profil-alice.json", "value":{"name":"Alice"}}});
        let invalid_uuid = Uuid::new_v4();
        let invalid = json!({"uuid":invalid_uuid.to_string(),
            "name":format!("2026-01-15T17-23-21.000000Z-{invalid_uuid}.json"),
            "type":"delete", "data":{"path":"../outside.json"}});
        let first = integrate(root, vec![invalid, row.clone()]).unwrap();
        assert_eq!(first.uuids, vec![uuid]);
        assert!(first.changed);
        assert!(root.join("transactions.sent").join(&name).is_file());
        assert!(!root.join("transactions").exists());

        let mut duplicate = row;
        duplicate["data"]["value"] = json!({"name":"Other"});
        let again = integrate(root, vec![duplicate]).unwrap();
        assert_eq!(again.uuids, vec![uuid]);
        assert!(!again.changed);
        let stored = fs::read(root.join("profiles/profil-alice.json")).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&stored).unwrap(),
            json!({"name":"Alice"})
        );
    }
}
