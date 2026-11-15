use crate::{storage::atomic_write, transaction_index};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Mutex, time::SystemTime};
use uuid::Uuid;

static LAST_STAMP: Mutex<i64> = Mutex::new(0);

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
    Ok(())
}
