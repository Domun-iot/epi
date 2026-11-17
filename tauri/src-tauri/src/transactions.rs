use crate::{
    storage::{atomic_write, read_bytes, restore_file, valid_transaction_path, version_time},
    transaction_index,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
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
            Err("epi-i18n:diagnostic.invalidDataPath2".into())
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
pub async fn pending_transactions(
    app: AppHandle,
    dataset_id: Option<String>,
    dataset_generation: Option<u64>,
) -> Result<Vec<PendingTransaction>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::account_storage::lock_for_app(&app)?;
        read_pending(&crate::storage::data_root_for(
            &app,
            dataset_id.as_deref(),
            dataset_generation,
        )?)
    })
    .await
    .map_err(message)?
}

#[tauri::command]
pub async fn archive_transactions(
    app: AppHandle,
    names: Vec<String>,
    dataset_id: Option<String>,
    dataset_generation: Option<u64>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::account_storage::lock_for_app(&app)?;
        let root = crate::storage::data_root_for(&app, dataset_id.as_deref(), dataset_generation)?;
        let pending = root.join("transactions");
        let sent = root.join("transactions.sent");
        check_directory(&pending)?;
        check_directory(&sent)?;
        fs::create_dir_all(&sent).map_err(message)?;
        for name in names {
            if filename_uuid(&name).is_none() {
                return Err(format!(
                    "epi-i18n:diagnostic.invalidTransactionUuid · {name}"
                ));
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
    pub(crate) uuids: Vec<Uuid>,
    pub(crate) changed: bool,
}

fn local_ids(root: &Path) -> Result<HashSet<Uuid>, String> {
    let index = root.join("transactions.index");
    if fs::symlink_metadata(index).is_ok_and(|meta| !meta.is_file() || meta.is_symlink()) {
        return Err("epi-i18n:diagnostic.invalidDataPath2".into());
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

fn transaction_time(name: &str) -> Option<i64> {
    name.get(..27)
        .and_then(|stamp| {
            chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H-%M-%S%.fZ").ok()
        })
        .map(|stamp| stamp.and_utc().timestamp_millis())
}
pub(crate) fn validate_transaction(transaction: &Value, name: &str) -> Result<(), String> {
    let invalid = || format!("epi-i18n:diagnostic.invalidTransactionUuid · {name}");
    let id = transaction["uuid"]
        .as_str()
        .and_then(|id| {
            Uuid::parse_str(id)
                .ok()
                .filter(|uuid| uuid.to_string() == id)
        })
        .ok_or_else(invalid)?;
    if filename_uuid(name) != Some(id) {
        return Err(invalid());
    }
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
    for operation in operations {
        if !operation.is_object() {
            return Err(invalid());
        }
        let path = operation["path"]
            .as_str()
            .filter(|path| valid_transaction_path(path) && paths.insert(path.to_lowercase()))
            .ok_or_else(invalid)?;
        let _ = path;
        let op = if kind == "batch" {
            operation["type"].as_str()
        } else {
            Some(kind)
        };
        match (op, operation.get("value")) {
            (Some("create" | "update"), Some(value)) if value.is_object() => {}
            (Some("delete"), None) => {}
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
fn remember_deletes(tombstones: &mut HashMap<String, i64>, value: &Value, name: &str) {
    let Some(time) = transaction_time(name) else {
        return;
    };
    let kind = value["type"].as_str();
    let mut remember = |path: &str| {
        if !valid_transaction_path(path) {
            return;
        }
        let current = tombstones.entry(path.to_lowercase()).or_insert(time);
        *current = (*current).max(time);
    };
    if kind == Some("batch") {
        if let Some(rows) = value["data"].as_array() {
            for row in rows {
                if row["type"] == "delete" {
                    if let Some(path) = row["path"].as_str() {
                        remember(path);
                    }
                }
            }
        }
    } else if kind == Some("delete") {
        if let Some(path) = value["data"]["path"].as_str() {
            remember(path);
        }
    }
}
fn transaction_tombstones(root: &Path) -> Result<HashMap<String, i64>, String> {
    let mut tombstones = HashMap::new();
    for folder in ["transactions", "transactions.sent"] {
        let directory = root.join(folder);
        check_directory(&directory)?;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(message(e)),
        };
        for entry in entries {
            let entry = entry.map_err(message)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().map_err(message)?.is_file() || filename_uuid(&name).is_none() {
                continue;
            }
            let value: Value = serde_json::from_str(
                fs::read_to_string(entry.path())
                    .map_err(message)?
                    .trim_start_matches('\u{feff}'),
            )
            .map_err(message)?;
            remember_deletes(&mut tombstones, &value, &name);
        }
    }
    Ok(tombstones)
}

fn transaction_changes(
    root: &Path,
    transaction: &Value,
    name: &str,
    tombstones: &HashMap<String, i64>,
) -> Result<Vec<FileChange>, String> {
    let invalid = || "epi-i18n:diagnostic.invalidDataPath2".to_owned();
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
            let mut after = match (op, operation.get("value")) {
                (Some("create" | "update"), Some(value)) => {
                    let mut bytes = serde_json::to_vec_pretty(value).map_err(message)?;
                    bytes.push(b'\n');
                    Some(bytes)
                }
                (Some("delete"), None) => None,
                _ => return Err(invalid()),
            };
            let before = read_bytes(&path)?;
            if after.is_some() {
                let candidate =
                    version_time(&operation["value"]).or_else(|| transaction_time(name));
                if tombstones
                    .get(&relative.to_lowercase())
                    .is_some_and(|deleted| candidate.is_none_or(|time| time <= *deleted))
                {
                    after = before.clone();
                }
            }
            if let Some(bytes) = &before {
                let text = std::str::from_utf8(bytes).map_err(message)?;
                let current: Value =
                    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(message)?;
                if current == operation["value"] && op != Some("delete") {
                    after = before.clone();
                } else if let Some(current_time) = version_time(&current) {
                    let candidate_time = if op == Some("delete") {
                        name.get(..27)
                            .and_then(|stamp| {
                                chrono::NaiveDateTime::parse_from_str(
                                    stamp,
                                    "%Y-%m-%dT%H-%M-%S%.fZ",
                                )
                                .ok()
                            })
                            .map(|stamp| stamp.and_utc().timestamp_millis())
                    } else {
                        version_time(&operation["value"]).or_else(|| transaction_time(name))
                    };
                    if candidate_time <= Some(current_time) {
                        after = before.clone();
                    }
                }
            }
            Ok(FileChange {
                before,
                path,
                after,
            })
        })
        .collect()
}

fn apply_received(
    root: &Path,
    uuid: Uuid,
    name: &str,
    transaction: &Value,
    tombstones: &HashMap<String, i64>,
) -> Result<bool, String> {
    let mut archive = transaction.clone();
    archive
        .as_object_mut()
        .ok_or("epi-i18n:diagnostic.invalidDataPath2")?
        .remove("name");
    let mut bytes = serde_json::to_vec_pretty(&archive).map_err(message)?;
    bytes.push(b'\n');
    let destination = root.join("transactions.sent").join(name);
    let mut changes = transaction_changes(root, transaction, name, tombstones)?;
    let changed = changes.iter().any(|change| change.before != change.after);
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
                return Err("epi-i18n:diagnostic.invalidDataPath2".into());
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
    result.map(|()| changed)
}

pub(crate) fn integrate(root: &Path, rows: Vec<Value>) -> Result<IntegratedTransactions, String> {
    let mut ids = local_ids(root)?;
    let mut tombstones = transaction_tombstones(root)?;
    let mut acknowledged = HashSet::new();
    let mut result = IntegratedTransactions {
        uuids: Vec::new(),
        changed: false,
    };
    for transaction in rows {
        let Some(name) = transaction["name"].as_str() else {
            continue;
        };
        if validate_transaction(&transaction, name).is_err() {
            continue;
        }
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
            let Ok(changed) = apply_received(root, uuid, name, &transaction, &tombstones) else {
                continue;
            };
            ids.insert(uuid);
            remember_deletes(&mut tombstones, &transaction, name);
            result.changed |= changed;
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
    dataset_id: Option<String>,
    dataset_generation: Option<u64>,
) -> Result<IntegratedTransactions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::account_storage::lock_for_app(&app)?;
        integrate(
            &crate::storage::data_root_for(&app, dataset_id.as_deref(), dataset_generation)?,
            transactions,
        )
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
    fn stale_update_and_delete_are_acknowledged_without_changing_data() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = "profiles/profil-alice.json";
        let transaction = |day: &str, kind: &str, data: Value| {
            let uuid = Uuid::new_v4();
            (
                uuid,
                json!({
                    "uuid": uuid.to_string(), "name": format!("2026-01-{day}T00-00-00.000000Z-{uuid}.json"),
                    "type": kind, "data": data,
                }),
            )
        };
        let current = json!({"name":"Alice", "createdAt":"2026-01-01T00:00:00.000Z", "updatedAt":"2026-01-15T00:00:00.000Z"});
        let (_, create) = transaction("16", "create", json!({"path":path, "value":current}));
        assert!(integrate(root, vec![create]).unwrap().changed);
        let (older, update) = transaction(
            "17",
            "update",
            json!({"path":path, "value":{"name":"old", "createdAt":"2026-01-01T00:00:00.000Z"}}),
        );
        let (deletion, delete) = transaction("12", "delete", json!({"path":path}));
        let result = integrate(root, vec![update, delete]).unwrap();
        assert_eq!(result.uuids, vec![older, deletion]);
        assert!(!result.changed);
        let stored = fs::read(root.join(path)).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&stored).unwrap(), current);
    }

    #[test]
    fn malformed_values_are_not_acknowledged_and_unversioned_updates_use_the_transaction_time() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = "profiles/profil-alice.json";
        fs::create_dir_all(root.join("profiles")).unwrap();
        fs::write(
            root.join(path),
            r#"{"name":"Alice","createdAt":"2026-01-01T00:00:00.000Z"}"#,
        )
        .unwrap();
        let row = |value: Value| {
            let id = Uuid::new_v4();
            json!({"uuid":id,"name":format!("2026-02-01T00-00-00.000000Z-{id}.json"),"type":"update","data":{"path":path,"value":value}})
        };
        assert!(integrate(root, vec![row(Value::Null)])
            .unwrap()
            .uuids
            .is_empty());
        assert!(integrate(root, vec![row(json!([1, 2]))])
            .unwrap()
            .uuids
            .is_empty());
        assert_eq!(
            integrate(root, vec![row(json!({"name":"Alice updated"}))])
                .unwrap()
                .uuids
                .len(),
            1
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(root.join(path)).unwrap()).unwrap()["name"],
            "Alice updated"
        );
    }
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
