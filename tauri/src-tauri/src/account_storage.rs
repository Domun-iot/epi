use crate::{storage, transactions};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use tauri::AppHandle;
use uuid::Uuid;

pub(crate) static DATASET_LOCK: Mutex<()> = Mutex::new(());
const ENTRIES: &[&str] = &[
    "devices",
    "measures",
    "profiles",
    "prefs",
    "notifications",
    "transactions",
    "transactions.sent",
    "transactions.incoming",
    "transactions.index",
    "interface.json",
    "session.json",
];
fn error(value: impl std::fmt::Display) -> String {
    value.to_string()
}
pub(crate) struct DatasetGuard {
    _installation: crate::installation_lock::InstallationLock,
    _process: MutexGuard<'static, ()>,
}
pub(crate) fn lock(root: &Path) -> Result<DatasetGuard, String> {
    let process = DATASET_LOCK.lock().map_err(error)?;
    let installation = crate::installation_lock::acquire(root)?;
    Ok(DatasetGuard {
        _installation: installation,
        _process: process,
    })
}
pub(crate) fn lock_for_app(app: &AppHandle) -> Result<DatasetGuard, String> {
    lock(&storage::installation_root(app)?)
}
fn valid_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id)
}
fn read(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(contents.trim_start_matches('\u{feff}'))
            .map(Some)
            .map_err(error),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(e)),
    }
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(error)?;
    bytes.push(b'\n');
    storage::atomic_write(path, &bytes, true).map(|_| ())
}
fn safe(path: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(error(e)),
    };
    if meta.is_symlink() || !(meta.is_dir() || meta.is_file()) {
        return Err("Unexpected dataset path.".into());
    }
    if meta.is_dir() {
        for item in fs::read_dir(path).map_err(error)? {
            safe(&item.map_err(error)?.path())?;
        }
    }
    Ok(())
}
fn safe_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_dir() || meta.is_symlink() => Err("Unexpected data directory.".into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
fn copy(source: &Path, target: &Path) -> Result<(), String> {
    safe(source)?;
    if source.is_dir() {
        fs::create_dir_all(target).map_err(error)?;
        for entry in fs::read_dir(source).map_err(error)? {
            let entry = entry.map_err(error)?;
            copy(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        fs::copy(source, target).map_err(error)?;
    }
    Ok(())
}
#[cfg(any(desktop, test))]
pub(crate) fn is_data_root(root: &Path) -> bool {
    ["devices", "measures", "profiles"]
        .iter()
        .all(|name| root.join(name).is_dir())
        || root.join("local").is_dir()
        || root.join("accounts").is_dir()
        || root.join("installation.json").is_file()
        || root.join("migration.json").is_file()
}
fn finish_migration(root: &Path, migration: &Value) -> Result<(), String> {
    let entries = migration["entries"]
        .as_array()
        .ok_or("Invalid migration journal.")?;
    fs::create_dir_all(root.join("local")).map_err(error)?;
    for item in entries {
        let name = item
            .as_str()
            .filter(|name| ENTRIES.contains(name))
            .ok_or("Invalid migration entry.")?;
        let from = root.join(name);
        let to = root.join("local").join(name);
        if !from.exists() {
            continue;
        }
        if to.exists() {
            return Err(format!("Ambiguous interrupted migration: {name}"));
        }
        safe(&from)?;
        fs::rename(from, to).map_err(error)?;
    }
    fs::remove_file(root.join("migration.json")).map_err(error)
}
fn recover_replacement(root: &Path) -> Result<(), String> {
    let Some(journal) = read(&root.join("replacement.json"))? else {
        return Ok(());
    };
    let id = journal["accountId"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or("Invalid replacement account.")?;
    let temporary = journal["temporary"]
        .as_str()
        .filter(|name| name.strip_prefix(".account-").is_some_and(valid_id))
        .ok_or("Invalid replacement stage.")?;
    let backup = if journal["backup"].is_null() {
        None
    } else {
        Some(
            journal["backup"]
                .as_str()
                .filter(|name| {
                    name.strip_prefix(&format!("account-{id}-"))
                        .is_some_and(valid_id)
                })
                .ok_or("Invalid replacement backup.")?,
        )
    };
    if journal["nextConfig"]["activeAccountId"] != id {
        return Err("Invalid replacement settings.".into());
    }
    let target = root.join("accounts").join(id);
    let temporary = root.join(temporary);
    let backup = backup.map(|name| root.join("backups").join(name));
    safe_directory(&target)?;
    safe_directory(&temporary)?;
    if let Some(backup) = &backup {
        safe_directory(backup)?;
    }
    if !target.exists() && !temporary.exists() && backup.as_ref().is_none_or(|path| !path.exists())
    {
        return Err("Missing staged account dataset.".into());
    }
    if target.exists() && !temporary.exists() {
        write(&root.join("installation.json"), &journal["nextConfig"])?;
    } else {
        if !target.exists() {
            if let Some(backup) = backup.filter(|path| path.exists()) {
                fs::rename(backup, &target).map_err(error)?;
            }
        }
        if temporary.exists() {
            fs::remove_dir_all(temporary).map_err(error)?;
        }
    }
    fs::remove_file(root.join("replacement.json")).map_err(error)
}
pub(crate) fn initialize(root: &Path) -> Result<Value, String> {
    let _installation = crate::installation_lock::acquire(root)?;
    fs::create_dir_all(root).map_err(error)?;
    for name in ["local", "accounts", "backups"] {
        safe_directory(&root.join(name))?;
    }
    for name in ["installation.json", "migration.json", "replacement.json"] {
        safe(&root.join(name))?;
    }
    recover_replacement(root)?;
    safe(&root.join("installation.json"))?;
    if let Some(migration) = read(&root.join("migration.json"))? {
        finish_migration(root, &migration)?;
    }
    let legacy: Vec<_> = ENTRIES
        .iter()
        .filter(|name| root.join(name).exists())
        .copied()
        .collect();
    if !legacy.is_empty() {
        let local = root.join("local");
        if local.exists() && fs::read_dir(&local).map_err(error)?.next().is_some() {
            return Err(
                "Both legacy and local datasets exist; migration requires recovery.".into(),
            );
        }
        if root.join("transactions.replay.lock").exists() {
            return Err("Transaction replay is active.".into());
        }
        let backup = root
            .join("backups")
            .join(format!("legacy-{}", Uuid::new_v4()));
        fs::create_dir_all(&backup).map_err(error)?;
        for name in &legacy {
            copy(&root.join(name), &backup.join(name))?;
        }
        let journal = json!({"entries":legacy});
        write(&root.join("migration.json"), &journal)?;
        finish_migration(root, &journal)?;
    }
    let mut config = read(&root.join("installation.json"))?.unwrap_or_else(|| json!({}));
    if !config.is_object() {
        return Err("Invalid installation settings.".into());
    }
    if config
        .get("accountModeEnabled")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("Invalid account mode setting.".into());
    }
    if let Some(id) = config["activeAccountId"].as_str() {
        if !valid_id(id) {
            return Err("Invalid account UUID.".into());
        }
    } else if !config["activeAccountId"].is_null() {
        return Err("Invalid account UUID.".into());
    }
    if config.get("activeAccountId").is_none() {
        config["activeAccountId"] = Value::Null;
    }
    let accounts = root.join("accounts");
    let has_accounts = if accounts.is_dir() {
        fs::read_dir(&accounts)
            .map_err(error)?
            .filter_map(Result::ok)
            .any(|entry| {
                entry.file_type().is_ok_and(|ty| ty.is_dir())
                    && valid_id(&entry.file_name().to_string_lossy())
            })
    } else {
        false
    };
    config["accountModeEnabled"] = json!(
        config["accountModeEnabled"] == true
            || !config["activeAccountId"].is_null()
            || has_accounts
    );
    if let Some(name) = config["pendingAnonymousBackup"].as_str().map(str::to_owned) {
        if !name.strip_prefix("anonymous-").is_some_and(valid_id) {
            return Err("Invalid backup journal.".into());
        }
        let source = root.join("local");
        let destination = root.join("backups").join(name);
        if source.exists() {
            if destination.exists() {
                return Err("Ambiguous anonymous backup.".into());
            }
            fs::create_dir_all(destination.parent().unwrap()).map_err(error)?;
            fs::rename(source, destination).map_err(error)?;
        }
        config
            .as_object_mut()
            .unwrap()
            .remove("pendingAnonymousBackup");
    }
    // Window bounds belong to this installation, including when no dataset is unlocked.
    if config.get("window").is_none() {
        let old = read(&root.join("local/prefs/global.json"))?
            .or(read(&root.join("local/interface.json"))?);
        if let Some(window) = old.and_then(|value| value.get("window").cloned()) {
            config["window"] = window;
        }
    }
    if config.get("syncReadyAccountIds").is_none() {
        config["syncReadyAccountIds"] = json!([]);
    }
    if !config["syncReadyAccountIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().all(|id| id.as_str().is_some_and(valid_id)))
    {
        return Err("Invalid synchronization account settings.".into());
    }
    if config.get("syncRevisions").is_none() {
        config["syncRevisions"] = json!({});
    }
    if !config["syncRevisions"]
        .as_object()
        .is_some_and(|revisions| {
            revisions.iter().all(|(id, value)| {
                valid_id(id)
                    && value.as_str().is_some_and(|revision| {
                        revision.len() == 64
                            && revision
                                .bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    })
            })
        })
    {
        return Err("Invalid synchronization revision settings.".into());
    }
    if config.get("datasetGeneration").is_none() {
        config["datasetGeneration"] = json!(0);
    }
    if config["datasetGeneration"].as_u64().is_none() {
        return Err("Invalid dataset generation.".into());
    }
    config["layoutVersion"] = json!(1);
    write(&root.join("installation.json"), &config)?;
    if config["accountModeEnabled"] != true {
        fs::create_dir_all(root.join("local")).map_err(error)?;
    }
    Ok(config)
}
fn summary(root: &Path) -> Result<Value, String> {
    fn visit(
        path: &Path,
        ids: &mut HashSet<String>,
        count: &mut usize,
        dates: &mut Vec<String>,
    ) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(path).map_err(error)? {
            let entry = entry.map_err(error)?;
            let ty = entry.file_type().map_err(error)?;
            if ty.is_symlink() {
                return Err("Unexpected measurement symlink.".into());
            }
            if ty.is_dir() {
                visit(&entry.path(), ids, count, dates)?;
            } else if ty.is_file() && entry.path().extension().is_some_and(|ext| ext == "json") {
                let value = read(&entry.path())?.ok_or("Measurement disappeared.")?;
                let id = value["uuid"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| entry.path().to_string_lossy().into_owned());
                if !ids.insert(id) {
                    continue;
                }
                *count += 1;
                if let Some(date) = value["receivedAt"]
                    .as_str()
                    .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
                {
                    dates.push(date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                }
            }
        }
        Ok(())
    }
    let mut ids = HashSet::new();
    let mut count = 0;
    let mut dates = Vec::new();
    visit(&root.join("measures"), &mut ids, &mut count, &mut dates)?;
    dates.sort();
    let has_data = count > 0
        || ["profiles", "devices"].iter().any(|name| {
            root.join(name).is_dir()
                && fs::read_dir(root.join(name)).is_ok_and(|mut items| items.next().is_some())
        });
    let has_data = has_data
        || read(&root.join("prefs/global.json"))?.is_some_and(|value| {
            value["pending"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        });
    Ok(json!({"count":count,"from":dates.first(),"to":dates.last(),"hasData":has_data}))
}
fn context(root: &Path) -> Result<Value, String> {
    let _installation = crate::installation_lock::acquire(root)?;
    let config = initialize(root)?;
    let locked = config["accountModeEnabled"] == true && config["activeAccountId"].is_null();
    let dataset_id = if locked {
        Value::Null
    } else {
        config["activeAccountId"]
            .as_str()
            .map_or(json!("local"), |id| json!(id))
    };
    let mut result = json!({"activeAccountId":config["activeAccountId"],"accountModeEnabled":config["accountModeEnabled"],
        "locked":locked,"datasetId":dataset_id,"datasetGeneration":config["datasetGeneration"],
        "syncReady":config["syncReadyAccountIds"].as_array().unwrap().contains(&config["activeAccountId"]),
        "localSummary":summary(&root.join("local"))?});
    if let Some(revision) =
        config["syncRevisions"][config["activeAccountId"].as_str().unwrap_or("")].as_str()
    {
        result["syncRevision"] = json!(revision);
    }
    Ok(result)
}
pub(crate) fn resolve_active(
    root: &Path,
    expected: Option<&str>,
    require_expected: bool,
    expected_generation: Option<u64>,
) -> Result<PathBuf, String> {
    let config = initialize(root)?;
    let id = config["activeAccountId"].as_str();
    if config["accountModeEnabled"] == true && id.is_none() {
        return Err("dataset_locked".into());
    }
    let actual = id.unwrap_or("local");
    if expected.is_some_and(|value| value != actual)
        || expected_generation
            .is_some_and(|value| Some(value) != config["datasetGeneration"].as_u64())
        || (require_expected
            && id.is_some()
            && (expected.is_none() || expected_generation.is_none()))
    {
        return Err("dataset_changed".into());
    }
    let target = id.map_or_else(|| root.join("local"), |id| root.join("accounts").join(id));
    safe(&target)?;
    if id.is_some() && !target.is_dir() {
        return Err("The selected account dataset is missing.".into());
    }
    for folder in ["profiles", "devices", "measures"] {
        fs::create_dir_all(target.join(folder)).map_err(error)?;
    }
    Ok(target)
}
fn prepare(root: &Path, account_id: &str) -> Result<Value, String> {
    let _installation = crate::installation_lock::acquire(root)?;
    if !valid_id(account_id) {
        return Err("Invalid account UUID.".into());
    }
    let mut result = context(root)?;
    let target = root.join("accounts").join(account_id);
    safe(&target)?;
    result["accountExists"] = json!(target.is_dir());
    result["accountSummary"] = summary(&target)?;
    result["syncReady"] = json!(initialize(root)?["syncReadyAccountIds"]
        .as_array()
        .unwrap()
        .contains(&json!(account_id)));
    result.as_object_mut().unwrap().remove("syncRevision");
    if let Some(revision) = initialize(root)?["syncRevisions"][account_id].as_str() {
        result["syncRevision"] = json!(revision);
    }
    Ok(result)
}
fn queue_baseline(root: &Path) -> Result<(), String> {
    for file in storage::snapshot_files(root)? {
        if file.path.starts_with("transactions") {
            continue;
        }
        let mut value: Value =
            serde_json::from_str(file.contents.trim_start_matches('\u{feff}')).map_err(error)?;
        if file.path == "prefs/global.json" || file.path == "interface.json" {
            if let Some(fields) = value.as_object_mut() {
                fields.remove("window");
            }
        }
        transactions::record(
            root,
            vec![json!({"type":"create","path":file.path,"value":value})],
        )
        .map_err(|e| format!("Dataset baseline {}: {e}", root.display()))?;
    }
    Ok(())
}
fn select_account(
    config: &mut Value,
    account_id: &str,
    sync_ready: bool,
    sync_revision: Option<&str>,
) -> Result<(), String> {
    config["activeAccountId"] = json!(account_id);
    config["accountModeEnabled"] = json!(true);
    let generation = config["datasetGeneration"]
        .as_u64()
        .unwrap()
        .checked_add(1)
        .ok_or("Dataset generation overflow.")?;
    config["datasetGeneration"] = json!(generation);
    if sync_ready {
        let ids = config["syncReadyAccountIds"].as_array_mut().unwrap();
        if !ids.contains(&json!(account_id)) {
            ids.push(json!(account_id));
        }
    }
    if let Some(revision) = sync_revision {
        config["syncRevisions"][account_id] = json!(revision);
    }
    Ok(())
}
fn activate_with_revision(
    root: &Path,
    account_id: &str,
    mode: &str,
    remote_files: Vec<storage::DataFile>,
    sync_ready: bool,
    sync_revision: Option<&str>,
) -> Result<Value, String> {
    if sync_revision.is_some_and(|revision| {
        revision.len() != 64
            || !revision
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }) {
        return Err("Invalid synchronization revision.".into());
    }
    let _installation = crate::installation_lock::acquire(root)?;
    if !valid_id(account_id) {
        return Err("Invalid account UUID.".into());
    }
    if !["attach", "merge", "remote", "existing"].contains(&mode) {
        return Err("Invalid account activation mode.".into());
    }
    let mut config = initialize(root)?;
    let target = root.join("accounts").join(account_id);
    safe_directory(&target)?;
    let replacing = target.exists();
    if replacing && !["merge", "remote"].contains(&mode) {
        if mode != "existing" || !remote_files.is_empty() {
            return Err("This account already has a local dataset.".into());
        }
        safe(&target)?;
        select_account(&mut config, account_id, sync_ready, sync_revision)?;
        write(&root.join("installation.json"), &config)?;
        return context(root);
    }
    if mode == "existing" {
        return Err("The account dataset does not exist.".into());
    }
    let temporary = root.join(format!(".account-{}", Uuid::new_v4()));
    fs::create_dir_all(&temporary).map_err(error)?;
    let anonymous = root.join("local");
    let attach_anonymous = config["accountModeEnabled"] != true && anonymous.exists();
    let result = (|| {
        if attach_anonymous && mode == "attach" {
            copy(&anonymous, &temporary)?;
            queue_baseline(&temporary)?;
        }
        if !remote_files.is_empty() {
            storage::merge_snapshot(&temporary, remote_files)?;
        }
        if mode == "merge" && (attach_anonymous || replacing) {
            let source = tempfile::tempdir_in(root).map_err(error)?;
            copy(if replacing { &target } else { &anonymous }, source.path())?;
            queue_baseline(source.path())?;
            let mut rows = std::collections::BTreeMap::new();
            for file in storage::snapshot_files(source.path())? {
                if file.path.starts_with("transactions/")
                    || file.path.starts_with("transactions.sent/")
                {
                    let name = file
                        .path
                        .split('/')
                        .nth(1)
                        .ok_or("Invalid history name.")?
                        .to_owned();
                    let mut value: Value =
                        serde_json::from_str(file.contents.trim_start_matches('\u{feff}'))
                            .map_err(error)?;
                    value["name"] = json!(name);
                    rows.insert(name, value);
                }
            }
            let expected: HashSet<_> = rows
                .values()
                .filter_map(|value| value["uuid"].as_str())
                .collect();
            let result = transactions::integrate(&temporary, rows.values().cloned().collect())?;
            if result.uuids.len() != expected.len() {
                return Err("Anonymous dataset merge failed.".into());
            }
            for (name, mut value) in rows {
                value.as_object_mut().unwrap().remove("name");
                let mut bytes = serde_json::to_vec_pretty(&value).map_err(error)?;
                bytes.push(b'\n');
                storage::atomic_write(&temporary.join("transactions").join(name), &bytes, false)?;
            }
        }
        select_account(&mut config, account_id, sync_ready, sync_revision)?;
        if attach_anonymous {
            config["pendingAnonymousBackup"] = json!(format!("anonymous-{}", Uuid::new_v4()));
        }
        fs::create_dir_all(target.parent().unwrap()).map_err(error)?;
        let backup = if replacing {
            let name = format!("account-{account_id}-{}", Uuid::new_v4());
            let backup = root.join("backups").join(&name);
            fs::create_dir_all(backup.parent().unwrap()).map_err(error)?;
            Some(backup)
        } else {
            None
        };
        write(
            &root.join("replacement.json"),
            &json!({"accountId":account_id,"temporary":temporary.file_name().unwrap().to_string_lossy(),
            "backup":backup.as_ref().map(|path| path.file_name().unwrap().to_string_lossy().into_owned()),"nextConfig":config}),
        )?;
        if let Some(backup) = &backup {
            fs::rename(&target, backup).map_err(error)?;
        }
        fs::rename(&temporary, &target).map_err(error)?;
        if let Err(e) = write(&root.join("installation.json"), &config) {
            fs::rename(&target, &temporary).map_err(error)?;
            if let Some(backup) = backup {
                fs::rename(backup, &target).map_err(error)?;
            }
            if root.join("replacement.json").exists() {
                fs::remove_file(root.join("replacement.json")).map_err(error)?;
            }
            return Err(e);
        }
        if root.join("replacement.json").exists() {
            fs::remove_file(root.join("replacement.json")).map_err(error)?;
        }
        context(root)
    })();
    if result.is_err() && root.join("replacement.json").exists() {
        recover_replacement(root)?;
    }
    if temporary.exists() {
        fs::remove_dir_all(&temporary).map_err(error)?;
    }
    result
}
#[cfg(test)]
fn activate(
    root: &Path,
    account_id: &str,
    mode: &str,
    files: Vec<storage::DataFile>,
    sync_ready: bool,
) -> Result<Value, String> {
    activate_with_revision(root, account_id, mode, files, sync_ready, None)
}
fn confirm_sync(root: &Path, account_id: &str, generation: u64) -> Result<Value, String> {
    let _installation = crate::installation_lock::acquire(root)?;
    resolve_active(root, Some(account_id), true, Some(generation))?;
    let mut config = initialize(root)?;
    config["syncRevisions"]
        .as_object_mut()
        .unwrap()
        .remove(account_id);
    write(&root.join("installation.json"), &config)?;
    context(root)
}
#[tauri::command]
pub fn confirm_dataset_sync(
    app: AppHandle,
    account_id: String,
    dataset_id: String,
    dataset_generation: u64,
) -> Result<Value, String> {
    let _guard = lock_for_app(&app)?;
    if dataset_id != account_id {
        return Err("dataset_changed".into());
    }
    confirm_sync(
        &storage::installation_root(&app)?,
        &account_id,
        dataset_generation,
    )
}
#[tauri::command]
pub fn get_dataset_context(app: AppHandle) -> Result<Value, String> {
    let _guard = lock_for_app(&app)?;
    context(&storage::installation_root(&app)?)
}
#[tauri::command]
pub fn prepare_account_dataset(app: AppHandle, account_id: String) -> Result<Value, String> {
    let _guard = lock_for_app(&app)?;
    prepare(&storage::installation_root(&app)?, &account_id)
}
#[tauri::command]
pub fn activate_account_dataset(
    app: AppHandle,
    account_id: String,
    mode: String,
    remote_files: Option<Vec<storage::DataFile>>,
    sync_ready: Option<bool>,
    sync_revision: Option<String>,
) -> Result<Value, String> {
    let _guard = lock_for_app(&app)?;
    activate_with_revision(
        &storage::installation_root(&app)?,
        &account_id,
        &mode,
        remote_files.unwrap_or_default(),
        sync_ready.unwrap_or(false),
        sync_revision.as_deref(),
    )
}
#[tauri::command]
pub fn logout_dataset(app: AppHandle) -> Result<Value, String> {
    let _guard = lock_for_app(&app)?;
    let root = storage::installation_root(&app)?;
    let mut config = initialize(&root)?;
    config["activeAccountId"] = Value::Null;
    config["datasetGeneration"] = json!(config["datasetGeneration"]
        .as_u64()
        .unwrap()
        .checked_add(1)
        .ok_or("Dataset generation overflow.")?);
    write(&root.join("installation.json"), &config)?;
    context(&root)
}
#[tauri::command]
pub fn mark_dataset_sync_ready(app: AppHandle, account_id: String) -> Result<Value, String> {
    let _guard = lock_for_app(&app)?;
    let root = storage::installation_root(&app)?;
    let mut config = initialize(&root)?;
    if config["activeAccountId"] != account_id {
        return Err("dataset_changed".into());
    }
    let ids = config["syncReadyAccountIds"].as_array_mut().unwrap();
    if !ids.contains(&json!(account_id)) {
        ids.push(json!(account_id));
    }
    write(&root.join("installation.json"), &config)?;
    context(&root)
}
#[cfg(desktop)]
pub(crate) fn read_window(root: &Path) -> Result<Value, String> {
    let _guard = lock(root)?;
    Ok(initialize(root)?["window"].clone())
}
#[cfg(desktop)]
pub(crate) fn save_window(root: &Path, value: Value) -> Result<(), String> {
    let _guard = lock(root)?;
    let mut config = initialize(root)?;
    config["window"] = value;
    write(&root.join("installation.json"), &config)
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    #[test]
    fn migrates_legacy_and_preserves_account_isolation_and_logout_lock() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("profiles")).unwrap();
        fs::write(
            root.join("profiles/profil-alice.json"),
            r#"{"name":"Alice"}"#,
        )
        .unwrap();
        assert_eq!(context(root).unwrap()["datasetId"], "local");
        assert!(root.join("local/profiles/profil-alice.json").exists());
        assert!(!root.join("profiles").exists());
        assert!(prepare(root, A).unwrap()["localSummary"]["hasData"] == true);
        activate(root, A, "attach", vec![], false).unwrap();
        assert!(root
            .join("accounts")
            .join(A)
            .join("profiles/profil-alice.json")
            .exists());
        assert!(!root.join("local").exists());
        assert!(resolve_active(root, Some("local"), true, None).is_err());
        activate(root, B, "attach", vec![], false).unwrap();
        assert!(!root
            .join("accounts")
            .join(B)
            .join("profiles/profil-alice.json")
            .exists());
        let mut config = initialize(root).unwrap();
        config["activeAccountId"] = Value::Null;
        write(&root.join("installation.json"), &config).unwrap();
        assert!(resolve_active(root, None, false, None).is_err());
        fs::remove_dir_all(root.join("accounts")).unwrap();
        assert_eq!(context(root).unwrap()["locked"], true);
    }
    #[test]
    fn resumes_migration_without_duplication() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("profiles")).unwrap();
        fs::create_dir_all(root.join("local/devices")).unwrap();
        write(
            &root.join("migration.json"),
            &json!({"entries":["profiles","devices"]}),
        )
        .unwrap();
        initialize(root).unwrap();
        assert!(root.join("local/profiles").is_dir());
        assert!(!root.join("migration.json").exists());
    }
    #[test]
    fn pro_review_replaces_only_the_selected_account_and_invalidates_old_work() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("profiles")).unwrap();
        fs::write(
            root.join("profiles/profil-alice.json"),
            r#"{"name":"Alice"}"#,
        )
        .unwrap();
        let first = activate(root, A, "attach", vec![], false).unwrap();
        assert_eq!(first["syncReady"], false);
        let remote = storage::DataFile {
            path: "profiles/profil-bob.json".into(),
            contents: r#"{"name":"Bob"}"#.into(),
        };
        let second = activate(root, A, "remote", vec![remote], true).unwrap();
        assert_eq!(second["syncReady"], true);
        assert!(resolve_active(root, Some(A), true, first["datasetGeneration"].as_u64()).is_err());
        let target =
            resolve_active(root, Some(A), true, second["datasetGeneration"].as_u64()).unwrap();
        assert!(!target.join("profiles/profil-alice.json").exists());
        assert!(target.join("profiles/profil-bob.json").exists());
        assert!(fs::read_dir(root.join("backups"))
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with("account-")));
    }
    #[test]
    fn merging_anonymous_data_keeps_newer_remote_versions_and_tombstones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("profiles")).unwrap();
        fs::write(
            root.join("profiles/profil-alice.json"),
            r#"{"name":"Alice","heightCm":160,"createdAt":"2026-01-01T00:00:00.000Z"}"#,
        )
        .unwrap();
        fs::write(
            root.join("profiles/profil-deleted.json"),
            r#"{"name":"Deleted","createdAt":"2026-01-01T00:00:00.000Z"}"#,
        )
        .unwrap();
        let id = Uuid::new_v4();
        let name = format!("2026-02-01T00-00-00.000000Z-{id}.json");
        let remote = vec![
            storage::DataFile { path: "profiles/profil-alice.json".into(), contents: r#"{"name":"Alice","heightCm":170,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-02-01T00:00:00.000Z"}"#.into() },
            storage::DataFile { path: format!("transactions.sent/{name}"), contents: json!({"uuid":id,"type":"delete","data":{"path":"profiles/profil-deleted.json"}}).to_string() },
        ];
        let selected = activate(root, A, "merge", remote, true).unwrap();
        let target =
            resolve_active(root, Some(A), true, selected["datasetGeneration"].as_u64()).unwrap();
        assert_eq!(
            read(&target.join("profiles/profil-alice.json"))
                .unwrap()
                .unwrap()["heightCm"],
            170
        );
        assert!(!target.join("profiles/profil-deleted.json").exists());
    }
    #[test]
    fn discovery_recognizes_local_and_account_only_installations() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(!is_data_root(root));
        fs::create_dir(root.join("local")).unwrap();
        assert!(is_data_root(root));
        fs::remove_dir(root.join("local")).unwrap();
        fs::create_dir_all(root.join("accounts").join(A)).unwrap();
        assert!(is_data_root(root));
    }
    #[test]
    fn bootstrap_revision_survives_restart_and_stale_confirmation_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let revision = "a".repeat(64);
        let initial =
            activate_with_revision(root, A, "attach", vec![], true, Some(&revision)).unwrap();
        assert_eq!(context(root).unwrap()["syncRevision"], revision);
        let next = activate_with_revision(root, A, "existing", vec![], true, Some(&"b".repeat(64)))
            .unwrap();
        assert!(confirm_sync(root, A, initial["datasetGeneration"].as_u64().unwrap()).is_err());
        assert_eq!(context(root).unwrap()["syncRevision"], "b".repeat(64));
        assert!(
            confirm_sync(root, A, next["datasetGeneration"].as_u64().unwrap())
                .unwrap()
                .get("syncRevision")
                .is_none()
        );
    }
    #[test]
    fn first_attachment_recovers_the_published_files_and_pending_anonymous_backup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut config = initialize(root).unwrap();
        fs::create_dir_all(root.join("local/profiles")).unwrap();
        fs::write(
            root.join("local/profiles/profil-alice.json"),
            r#"{"name":"Alice"}"#,
        )
        .unwrap();
        let temporary = format!(".account-{}", Uuid::new_v4());
        let backup = format!("anonymous-{}", Uuid::new_v4());
        fs::create_dir_all(root.join(&temporary).join("profiles")).unwrap();
        fs::write(
            root.join(&temporary).join("profiles/profil-alice.json"),
            r#"{"name":"Alice"}"#,
        )
        .unwrap();
        select_account(&mut config, A, true, Some(&"a".repeat(64))).unwrap();
        config["pendingAnonymousBackup"] = json!(backup);
        write(
            &root.join("replacement.json"),
            &json!({"accountId":A,"temporary":temporary,"backup":null,"nextConfig":config}),
        )
        .unwrap();
        fs::create_dir(root.join("accounts")).unwrap();
        fs::rename(root.join(temporary), root.join("accounts").join(A)).unwrap();
        assert_eq!(context(root).unwrap()["activeAccountId"], A);
        assert!(root
            .join("backups")
            .join(backup)
            .join("profiles/profil-alice.json")
            .exists());
        assert!(!root.join("replacement.json").exists());
    }
    #[test]
    fn non_directory_account_container_is_rejected_before_migration() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("profiles")).unwrap();
        fs::write(root.join("accounts"), "unexpected file").unwrap();
        assert!(initialize(root).is_err());
        assert!(root.join("profiles").is_dir());
        assert!(!root.join("local").exists());
    }
    #[test]
    fn rejects_invalid_remote_snapshot_without_selecting_account() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        initialize(root).unwrap();
        let file = storage::DataFile {
            path: "../outside.json".into(),
            contents: "{}".into(),
        };
        assert!(activate(root, A, "remote", vec![file], true).is_err());
        assert_eq!(context(root).unwrap()["datasetId"], "local");
        assert!(!root.join("accounts").join(A).exists());
    }
}
