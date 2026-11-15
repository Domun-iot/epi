use crate::{transaction_index, transactions};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

const PREFS: &str = "prefs/global.json";
const LEGACY_PREFS: &str = "interface.json";
static GLOBAL_PREFS_WRITE: Mutex<()> = Mutex::new(());
const VIEW_PRESET_FOLDERS: [(&str, &str); 2] = [
    ("measurements", "prefs/measurements"),
    ("details", "prefs/measurement-details"),
];

#[derive(serde::Serialize, serde::Deserialize)]
pub struct DataFile {
    path: String,
    contents: String,
}

#[cfg(desktop)]
fn shared_data(executable_dir: &Path) -> Option<PathBuf> {
    executable_dir
        .ancestors()
        .map(|parent| parent.join("data"))
        .find(|data| {
            ["devices", "measures", "profiles"]
                .iter()
                .all(|folder| data.join(folder).is_dir())
        })
}

pub(crate) fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(desktop)]
    {
        // An AppImage runs its ELF from a temporary mount. APPIMAGE points to the original file.
        #[cfg(target_os = "linux")]
        let executable = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .or_else(|| std::env::current_exe().ok());
        #[cfg(not(target_os = "linux"))]
        let executable = std::env::current_exe().ok();
        let root =
            if let Some(path) = std::env::var_os("EPI_DATA_DIR").filter(|path| !path.is_empty()) {
                PathBuf::from(path)
            } else if let Some(shared) = executable
                .as_deref()
                .and_then(Path::parent)
                .and_then(shared_data)
            {
                shared
            } else {
                app.path().app_data_dir().map_err(message)?.join("data")
            };
        for folder in ["devices", "measures", "profiles"] {
            fs::create_dir_all(root.join(folder)).map_err(message)?;
        }
        Ok(root)
    }
    #[cfg(not(desktop))]
    Ok(app.path().app_data_dir().map_err(message)?.join("data"))
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn entries(path: &Path) -> Result<Vec<fs::DirEntry>, String> {
    match fs::read_dir(path) {
        Ok(reader) => {
            let mut entries = reader.collect::<Result<Vec<_>, _>>().map_err(message)?;
            entries.sort_by_key(fs::DirEntry::file_name);
            Ok(entries)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(message(error)),
    }
}

fn dataset_files(root: &Path) -> Result<Vec<DataFile>, String> {
    fn collect(root: &Path, path: &Path, files: &mut Vec<DataFile>) -> Result<(), String> {
        for entry in entries(path)? {
            let ty = entry.file_type().map_err(message)?;
            let path = entry.path();
            if ty.is_dir() {
                collect(root, &path, files)?;
            } else if ty.is_file() && path.extension().is_some_and(|ext| ext == "json") {
                let relative = path.strip_prefix(root).map_err(message)?;
                let path_name = relative.to_string_lossy().replace('\\', "/");
                if valid_file(&path_name) {
                    let contents = fs::read_to_string(path).map_err(message)?;
                    files.push(DataFile {
                        path: path_name,
                        contents,
                    });
                }
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    for folder in ["profiles", "devices", "measures"] {
        collect(root, &root.join(folder), &mut files)?;
    }
    Ok(files)
}

fn safe_path(file: &str) -> bool {
    !file.split('/').any(|name| {
        name.is_empty()
            || name.starts_with('.')
            || name.ends_with('.')
            || name.ends_with(' ')
            || name.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
            || name.chars().any(char::is_control)
            || reserved(name.split('.').next().unwrap_or_default())
    })
}

fn valid_file(file: &str) -> bool {
    if !safe_path(file) {
        return false;
    }
    match file.split('/').collect::<Vec<_>>().as_slice() {
        ["profiles", name] => name.strip_suffix(".json").is_some_and(|stem| {
            valid_uuid(stem)
                || stem
                    .strip_prefix("profil-")
                    .is_some_and(|name| !name.is_empty())
        }),
        ["devices", name] | ["measures", _, name] => name.ends_with(".json"),
        _ => false,
    }
}

fn reserved(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            name.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok()
}

fn record_uuid(row: &Value) -> Option<&str> {
    row["uuid"].as_str().filter(|id| valid_uuid(id))
}

fn safe_name(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.starts_with(|c: char| !c.is_alphanumeric())
        || !value
            .chars()
            .all(|c| c.is_alphanumeric() || " _-".contains(c))
    {
        Err("epi-i18n:diagnostic.incompatibleDataName".into())
    } else {
        Ok(value)
    }
}

fn record(file: &DataFile) -> Result<Value, String> {
    let mut row: Value = serde_json::from_str(file.contents.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("{} · {error}", file.path))?;
    if !row.is_object() {
        return Err(format!(
            "epi-i18n:diagnostic.expectedJsonObjectAtPath · {}",
            file.path
        ));
    }
    if let Some(stem) = file
        .path
        .strip_prefix("profiles/profil-")
        .and_then(|name| name.strip_suffix(".json"))
    {
        if row["name"].as_str().is_none_or(str::is_empty) {
            let mut chars = stem.chars();
            let name = chars
                .next()
                .into_iter()
                .flat_map(char::to_uppercase)
                .chain(chars)
                .collect::<String>();
            row["name"] = json!(name);
        }
    }
    if file.path.starts_with("profiles/") || file.path.starts_with("devices/") {
        let stem = file
            .path
            .split('/')
            .nth(1)
            .and_then(|name| name.strip_suffix(".json"));
        if row["uuid"].is_null() {
            if let Some(id) = stem.filter(|id| valid_uuid(id)) {
                row["uuid"] = json!(id);
            }
        }
    }
    Ok(row)
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(message),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(message(error)),
    }
}

fn profile_prefs_path(root: &Path, profile: &str) -> PathBuf {
    let file = if safe_name(profile).is_ok() {
        format!("profil-{profile}.json")
    } else {
        let encoded: String = profile.bytes().map(|byte| format!("{byte:02x}")).collect();
        format!("profil~{encoded}.json")
    };
    root.join("prefs").join(file)
}

fn valid_view_preset_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn read_view_presets(root: &Path) -> Result<Value, String> {
    let mut presets = json!({});
    for (kind, folder) in VIEW_PRESET_FOLDERS {
        let mut items = Vec::new();
        for entry in entries(&root.join(folder))? {
            let path = entry.path();
            if !entry.file_type().map_err(message)?.is_file()
                || path.extension().is_none_or(|ext| ext != "json")
            {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .filter(|id| valid_view_preset_id(id))
            else {
                continue;
            };
            if let Some(item) = read_json(&path)? {
                if item["id"].as_str() == Some(id)
                    && item["name"].is_string()
                    && item["layout"].is_object()
                {
                    items.push(item);
                }
            }
        }
        presets[kind] = json!(items);
    }
    Ok(presets)
}

fn read_global_preferences(root: &Path) -> Result<Value, String> {
    Ok(match read_json(&root.join(PREFS))? {
        Some(prefs) => prefs,
        None => read_json(&root.join(LEGACY_PREFS))?.unwrap_or_else(|| json!({})),
    })
}

#[cfg(desktop)]
pub(crate) fn read_window_preferences(root: &Path) -> Result<Value, String> {
    Ok(read_global_preferences(root)?["window"].clone())
}

#[cfg(desktop)]
pub(crate) fn save_window_preferences(root: &Path, window: Value) -> Result<(), String> {
    update_global_preferences(root, |global| {
        global.insert("window".into(), window);
    })
}

fn update_global_preferences(
    root: &Path,
    update: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Result<(), String> {
    let _guard = GLOBAL_PREFS_WRITE.lock().map_err(message)?;
    let mut global = read_global_preferences(root)?;
    update(
        global
            .as_object_mut()
            .ok_or("epi-i18n:diagnostic.invalidGlobalPreferences")?,
    );
    save_json(root, &root.join(PREFS), &global, true)?;
    Ok(())
}

fn read_session(root: &Path) -> Result<Value, String> {
    let mut session = read_global_preferences(root)?;
    let mut profiles = Vec::new();
    let mut devices = Vec::new();
    let mut measurements = Vec::new();
    for file in dataset_files(root)? {
        let row = record(&file)?;
        if file.path.starts_with("profiles/") {
            profiles.push(row);
        } else if file.path.starts_with("devices/") {
            devices.push(row);
        } else {
            measurements.push(row);
        }
    }
    let mut preferences = serde_json::Map::new();
    for profile in profiles
        .iter()
        .filter_map(name)
        .filter(|name| !name.is_empty())
    {
        if let Some(prefs) = read_json(&profile_prefs_path(root, profile))? {
            preferences.insert(profile.to_owned(), prefs);
        }
    }
    session["profilePreferences"] = Value::Object(preferences);
    session["viewPresets"] = read_view_presets(root)?;
    session["notifications"] = read_notifications(root)?;
    session["profiles"] = json!(profiles);
    session["devices"] = json!(devices);
    session["measurements"] = json!(measurements);
    Ok(session)
}

pub(crate) fn atomic_write(path: &Path, data: &[u8], replace: bool) -> Result<bool, String> {
    let root = path
        .parent()
        .ok_or("epi-i18n:diagnostic.dataFolderNotFound")?;
    fs::create_dir_all(root).map_err(message)?;
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(message)?;
    temp.write_all(data).map_err(message)?;
    temp.as_file().sync_all().map_err(message)?;
    let result = if replace {
        temp.persist(path)
    } else {
        temp.persist_noclobber(path)
    };
    match result {
        Ok(_) => Ok(true),
        Err(error) if !replace && error.error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(message(error)),
    }
}

fn json_write(path: &Path, value: &Value, replace: bool) -> Result<bool, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(message)?;
    bytes.push(b'\n');
    atomic_write(path, &bytes, replace)
}

fn save_json(root: &Path, path: &Path, value: &Value, replace: bool) -> Result<bool, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(message)?;
    bytes.push(b'\n');
    save_file(root, path, &bytes, value, replace)
}

pub(crate) fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(message(error)),
    }
}

pub(crate) fn restore_file(path: &Path, before: Option<&[u8]>) -> Result<(), String> {
    match before {
        Some(bytes) => atomic_write(path, bytes, true).map(|_| ()),
        None => fs::remove_file(path).map_err(message),
    }
}

fn save_file(
    root: &Path,
    path: &Path,
    bytes: &[u8],
    value: &Value,
    replace: bool,
) -> Result<bool, String> {
    let before = read_bytes(path)?;
    if let Some(old) = &before {
        if !replace {
            return Ok(false);
        }
        if old == bytes {
            return Ok(true);
        }
    }
    let change = transactions::change(root, path, before.is_some(), Some(value))?;
    if !atomic_write(path, bytes, replace)? {
        return Ok(false);
    }
    if let Err(error) = transactions::record(root, vec![change]) {
        restore_file(path, before.as_deref()).map_err(|restore| format!("{error} · {restore}"))?;
        return Err(error);
    }
    Ok(true)
}

fn delete_file(root: &Path, path: &Path) -> Result<(), String> {
    let before = fs::read(path).map_err(message)?;
    let change = transactions::change(root, path, true, None)?;
    fs::remove_file(path).map_err(message)?;
    if let Err(error) = transactions::record(root, vec![change]) {
        restore_file(path, Some(&before)).map_err(|restore| format!("{error} · {restore}"))?;
        return Err(error);
    }
    Ok(())
}

fn rows<'a>(state: &'a Value, key: &str) -> &'a [Value] {
    state[key].as_array().map(Vec::as_slice).unwrap_or_default()
}

fn name(row: &Value) -> Option<&str> {
    row["name"].as_str()
}

fn address(row: &Value) -> Option<&str> {
    row["bluetooth"]["address"].as_str()
}

fn save_records(
    root: &Path,
    state: &Value,
    previous: &Value,
    key: &str,
    identity: fn(&Value) -> Option<&str>,
) -> Result<(), String> {
    let folder = format!("{key}/");
    let mut files = HashMap::new();
    for file in dataset_files(root)?
        .into_iter()
        .filter(|file| file.path.starts_with(&folder))
    {
        let row = record(&file)?;
        if let Some(id) = record_uuid(&row).or_else(|| identity(&row)) {
            files.insert(id.to_owned(), (file.path, row));
        }
    }
    for row in rows(state, key) {
        let id = record_uuid(row).ok_or("epi-i18n:diagnostic.invalidRecordUuid")?;
        let previous_row = rows(previous, key).iter().find(|old| {
            record_uuid(old).map_or_else(|| identity(old) == identity(row), |old_id| old_id == id)
        });
        let path = format!("{folder}{id}.json");
        let existing = files
            .get(id)
            .or_else(|| identity(row).and_then(|legacy| files.get(legacy)));
        if existing.is_some_and(|(file, current)| file == &path && current == row) {
            continue;
        }
        if previous_row == Some(row) && existing.is_none() {
            continue;
        }
        if existing.is_some_and(|(_, current)| current != row && previous_row != Some(current)) {
            return Err("epi-i18n:diagnostic.aFileHasBeenModifiedReload".into());
        }
        let existing_path = existing.map(|(file, _)| file);
        if !valid_file(&path) {
            return Err("epi-i18n:diagnostic.incompatibleFileName".into());
        }
        let replace = existing_path.is_some_and(|existing| existing.eq_ignore_ascii_case(&path));
        let target = root.join(if replace {
            existing_path.unwrap()
        } else {
            &path
        });
        let saved = if let Some(existing) = existing_path.filter(|_| !replace) {
            let source = root.join(existing);
            let before = fs::read(&source).map_err(message)?;
            let operations = vec![
                transactions::change(root, &target, false, Some(row))?,
                transactions::change(root, &source, true, None)?,
            ];
            if !json_write(&target, row, false)? {
                false
            } else {
                if let Err(error) = fs::remove_file(&source) {
                    restore_file(&target, None)?;
                    return Err(message(error));
                }
                if let Err(error) = transactions::record(root, operations) {
                    restore_file(&source, Some(&before))?;
                    restore_file(&target, None)?;
                    return Err(error);
                }
                true
            }
        } else {
            save_json(root, &target, row, replace)?
        };
        if !saved {
            return Err("epi-i18n:diagnostic.aFileAlreadyExistsReloadThe".into());
        }
    }
    Ok(())
}

fn update_measurement_identities(
    root: &Path,
    new: &[Value],
    previous: &[Value],
) -> Result<(), String> {
    if new
        .iter()
        .zip(previous)
        .all(|(after, before)| after == before)
    {
        return Ok(());
    }
    let mut paths = HashMap::<String, Vec<PathBuf>>::new();
    for file in dataset_files(root)?.into_iter().rev() {
        if file.path.starts_with("measures/") {
            paths
                .entry(row_key(&record(&file)?))
                .or_default()
                .push(root.join(&file.path));
        }
    }
    let mut writes = Vec::new();
    for (after, before) in new.iter().zip(previous) {
        let path = paths.get_mut(&row_key(before)).and_then(Vec::pop);
        if after == before {
            continue;
        }
        if let Some(path) = path {
            writes.push((path, after));
        } else if paths.get_mut(&row_key(after)).and_then(Vec::pop).is_none() {
            return Err("epi-i18n:diagnostic.weighInChanged".into());
        }
    }
    for (path, row) in writes {
        save_json(root, &path, row, true)?;
    }
    Ok(())
}

fn profile_measurement_folder(profile: &str) -> Result<String, String> {
    let folder = safe_name(profile)?.to_lowercase();
    Ok(if reserved(&folder) {
        format!("_{folder}")
    } else {
        folder
    })
}

fn measurement_folder(row: &Value, profiles: &[Value]) -> Result<String, String> {
    if let Some(id) = row["profile"]["uuid"]
        .as_str()
        .or_else(|| row["profileUuid"].as_str())
    {
        if !valid_uuid(id) {
            return Err("epi-i18n:diagnostic.invalidProfileUuid".into());
        }
        return Ok(id.to_ascii_lowercase());
    }
    match row["profile"]["name"].as_str() {
        Some(profile_name) => {
            let folder = profile_measurement_folder(profile_name)?;
            Ok(profiles
                .iter()
                .find(|profile| {
                    name(profile)
                        .is_some_and(|value| value.to_lowercase() == profile_name.to_lowercase())
                })
                .and_then(record_uuid)
                .map_or(folder, str::to_ascii_lowercase))
        }
        None => Ok("_sans-profil".into()),
    }
}

fn measurement_stamp(row: &Value) -> Result<String, String> {
    let received = row["receivedAt"]
        .as_str()
        .ok_or("epi-i18n:diagnostic.missingWeighInDate")?;
    let date = chrono::DateTime::parse_from_rfc3339(received)
        .map_err(|_| "epi-i18n:diagnostic.invalidWeighInDate")?;
    Ok(date
        .to_utc()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(':', "-"))
}

fn measurement_path(row: &Value, profiles: &[Value]) -> Result<String, String> {
    Ok(format!(
        "measures/{}/{}.json",
        measurement_folder(row, profiles)?,
        measurement_stamp(row)?
    ))
}

fn save_measurements(
    root: &Path,
    new: &[Value],
    previous: &[Value],
    profiles: &[Value],
) -> Result<(), String> {
    update_measurement_identities(root, new, previous)?;
    let appended = &new[previous.len()..];
    if appended.is_empty() {
        return Ok(());
    }
    let mut occupied = HashSet::new();
    for file in dataset_files(root)?
        .into_iter()
        .filter(|file| file.path.starts_with("measures/"))
    {
        if let Ok(slot) = measurement_path(&record(&file)?, profiles) {
            occupied.insert(slot);
        }
    }
    for row in appended {
        let path = measurement_path(row, profiles)?;
        if !valid_file(&path) {
            return Err("epi-i18n:diagnostic.invalidWeighInPath".into());
        }
        if occupied.insert(path.clone()) {
            save_json(root, &root.join(path), row, false)?;
        }
    }
    Ok(())
}

fn row_key(row: &Value) -> String {
    fn normalize_numbers(value: &mut Value) {
        match value {
            Value::Number(number) => {
                // JavaScript sends integral floats as integers.
                if let Some(float) = number.as_f64() {
                    *value = json!(if float == 0.0 { 0.0 } else { float });
                }
            }
            Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
            Value::Object(fields) => fields.values_mut().for_each(normalize_numbers),
            _ => {}
        }
    }
    let mut canonical = row.clone();
    normalize_numbers(&mut canonical);
    canonical.sort_all_objects();
    canonical.to_string()
}

fn row_counts(rows: &[Value]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for row in rows {
        *counts.entry(row_key(row)).or_insert(0) += 1;
    }
    counts
}

fn deletion_paths(root: &Path, session: &Value, previous: &Value) -> Result<Vec<PathBuf>, String> {
    let files = dataset_files(root)?;
    let mut paths = Vec::new();
    let deleting_profile = rows(session, "profiles").len() < rows(previous, "profiles").len();
    for (key, folder) in [
        ("profiles", "profiles/"),
        ("devices", "devices/"),
        ("measurements", "measures/"),
    ] {
        let before = rows(previous, key);
        let after = rows(session, key);
        // A profile deletion also checks for measurements added by the CLI since loading.
        if after.len() >= before.len() && !(key == "measurements" && deleting_profile) {
            continue;
        }
        let mut actual = Vec::new();
        let mut retained = row_counts(after);
        for file in files.iter().filter(|file| file.path.starts_with(folder)) {
            let row = record(file)?;
            let count = retained.entry(row_key(&row)).or_default();
            if *count > 0 {
                *count -= 1;
            } else {
                paths.push(root.join(&file.path));
            }
            actual.push(row);
        }
        if row_counts(&actual) != row_counts(before) || retained.values().any(|count| *count > 0) {
            return Err("epi-i18n:diagnostic.theDataHasChangedReloadThe".into());
        }
    }
    if let Some(prefs) = previous["profilePreferences"].as_object() {
        for profile in prefs.keys() {
            if session["profilePreferences"].get(profile).is_none() {
                let path = profile_prefs_path(root, profile);
                if path.try_exists().map_err(message)? {
                    paths.push(path);
                }
            }
        }
    }
    Ok(paths)
}

fn save_deletion(root: &Path, session: &Value, previous: &Value) -> Result<(), String> {
    let paths = deletion_paths(root, session, previous)?;
    let staging = tempfile::tempdir_in(root).map_err(message)?;
    let mut moved = Vec::new();
    let result = (|| {
        for (index, path) in paths.iter().enumerate() {
            let target = staging.path().join(index.to_string());
            fs::rename(path, &target).map_err(message)?;
            moved.push((path, target));
        }
        save_preferences(root, session, previous)?;
        let operations = paths
            .iter()
            .map(|path| transactions::change(root, path, true, None))
            .collect::<Result<Vec<_>, _>>()?;
        transactions::record(root, operations)
    })();
    if let Err(error) = result {
        let mut rollback_error = None;
        for (path, target) in moved.into_iter().rev() {
            if let Err(restore) = fs::rename(target, path) {
                rollback_error = Some(restore);
            }
        }
        if let Some(restore) = rollback_error {
            let backup = staging.keep();
            return Err(format!(
                "{error}\nepi-i18n:diagnostic.incompleteRollback · {restore} · {}",
                backup.display()
            ));
        }
        return Err(error);
    }
    if rows(session, "profiles").len() < rows(previous, "profiles").len() {
        let measures = root.join("measures");
        let retained: HashSet<_> = rows(session, "profiles").iter().filter_map(name).collect();
        let mut folders: HashSet<_> = rows(previous, "profiles")
            .iter()
            .filter(|row| name(row).is_some_and(|name| !retained.contains(name)))
            .flat_map(|row| {
                record_uuid(row)
                    .map(str::to_ascii_lowercase)
                    .into_iter()
                    .chain(name(row).and_then(|name| profile_measurement_folder(name).ok()))
            })
            .map(|folder| measures.join(folder))
            .collect();
        folders.extend(paths.iter().filter_map(|path| {
            path.parent()
                .filter(|parent| parent.parent() == Some(measures.as_path()))
                .map(Path::to_path_buf)
        }));
        for folder in folders {
            // Preserve files left in the folder, including concurrent recordings.
            let _ = fs::remove_dir(folder);
        }
    }
    Ok(())
}

fn notification_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let valid = id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if !valid {
        return Err("epi-i18n:diagnostic.invalidNotificationId".into());
    }
    Ok(root.join("notifications").join(format!("{id}.json")))
}

fn read_notifications(root: &Path) -> Result<Value, String> {
    let mut notifications = Vec::new();
    for entry in entries(&root.join("notifications"))? {
        let path = entry.path();
        if !entry.file_type().map_err(message)?.is_file()
            || path.extension().is_none_or(|ext| ext != "json")
        {
            continue;
        }
        if let Some(row) = read_json(&path)? {
            if let Some(id) = row["id"].as_str() {
                if notification_path(root, id).is_ok_and(|expected| expected == path)
                    && (row["date"].is_string()
                        || row["date"]
                            .as_u64()
                            .is_some_and(|date| date <= 8_640_000_000_000_000))
                {
                    notifications.push(row);
                }
            }
        }
    }
    Ok(json!(notifications))
}

fn with_notifications(
    root: &Path,
    session: &Value,
    previous: &Value,
    save: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    fn by_id(state: &Value) -> HashMap<&str, &Value> {
        rows(state, "notifications")
            .iter()
            .filter_map(|row| Some((row["id"].as_str()?, row)))
            .collect()
    }
    let before = by_id(previous);
    let after = by_id(session);
    let ids: HashSet<_> = before.keys().chain(after.keys()).collect();
    let mut undo = Vec::new();
    let mut operations = Vec::new();
    let result = (|| {
        for id in ids {
            if before.get(id) == after.get(id) {
                continue;
            }
            let path = notification_path(root, id)?;
            let old = read_json(&path)?;
            if let Some(row) = after.get(id) {
                if before
                    .get(id)
                    .is_some_and(|previous| Some(*previous) != old.as_ref())
                {
                    return Err("epi-i18n:diagnostic.theNotificationHasChangedReloadThe".into());
                }
                let change = transactions::change(root, &path, old.is_some(), Some(row))?;
                json_write(&path, row, true)?;
                operations.push(change);
            } else if old.is_some() {
                let change = transactions::change(root, &path, true, None)?;
                fs::remove_file(&path).map_err(message)?;
                operations.push(change);
            } else {
                continue;
            }
            undo.push((path, old));
        }
        save()?;
        transactions::record(root, operations)
    })();
    if let Err(error) = result {
        let mut rollback = Vec::new();
        for (path, old) in undo.into_iter().rev() {
            let restored = match old {
                Some(row) => json_write(&path, &row, true).map(|_| ()),
                None => fs::remove_file(&path).map_err(message),
            };
            if let Err(error) = restored {
                rollback.push(error);
            }
        }
        if !rollback.is_empty() {
            return Err(format!(
                "{error}\nepi-i18n:diagnostic.notificationLog · {}",
                rollback.join(" · ")
            ));
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn load_session(app: AppHandle) -> Result<Value, String> {
    let root = data_root(&app)?;
    let session = read_session(&root)?;
    // UUIDs from older versions may already be present in name-based files.
    for (key, identity) in [
        ("profiles", name as fn(&Value) -> Option<&str>),
        ("devices", address),
    ] {
        if rows(&session, key)
            .iter()
            .all(|row| record_uuid(row).is_some())
        {
            save_records(&root, &session, &session, key, identity)?;
        }
    }
    read_session(&root)
}

#[tauri::command]
pub fn save_session(app: AppHandle, session: Value, previous: Value) -> Result<bool, String> {
    let root = data_root(&app)?;
    let revision = transactions::record_revision();
    with_notifications(&root, &session, &previous, || {
        if [
            "profiles",
            "devices",
            "measurements",
            "viewPresets",
            "profilePreferences",
            "pending",
            "selectedProfile",
            "addressFilter",
            "anonymousPreferences",
        ]
        .iter()
        .all(|key| session[*key] == previous[*key])
        {
            return Ok(());
        }
        save_dataset(&root, &session, &previous)
    })?;
    Ok(revision != transactions::record_revision())
}

fn save_dataset(root: &Path, session: &Value, previous: &Value) -> Result<(), String> {
    if ["profiles", "devices", "measurements"]
        .iter()
        .any(|key| rows(session, key).len() < rows(previous, key).len())
    {
        return save_deletion(root, session, previous);
    }
    if session["profiles"] != previous["profiles"] {
        save_records(root, session, previous, "profiles", name)?;
    }
    if session["devices"] != previous["devices"] {
        save_records(root, session, previous, "devices", address)?;
    }
    save_measurements(
        root,
        rows(session, "measurements"),
        rows(previous, "measurements"),
        rows(session, "profiles"),
    )?;
    if session["viewPresets"] != previous["viewPresets"] {
        save_view_presets(root, &session["viewPresets"], &previous["viewPresets"])?;
    }
    save_preferences(root, session, previous)?;
    if let Some(preferences) = previous["profilePreferences"].as_object() {
        for profile in preferences
            .keys()
            .filter(|name| session["profilePreferences"].get(*name).is_none())
        {
            let path = profile_prefs_path(root, profile);
            let reused = rows(session, "profiles")
                .iter()
                .filter_map(name)
                .any(|name| {
                    profile_prefs_path(root, name)
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&path.to_string_lossy())
                });
            if !reused && path.try_exists().map_err(message)? {
                delete_file(root, &path)?;
            }
        }
    }
    Ok(())
}

fn save_view_presets(root: &Path, current: &Value, previous: &Value) -> Result<(), String> {
    for (kind, folder) in VIEW_PRESET_FOLDERS {
        let before = rows(previous, kind);
        let after = rows(current, kind);
        let mut processed = HashSet::new();
        for item in before.iter().chain(after.iter()) {
            let id = item["id"]
                .as_str()
                .filter(|id| valid_view_preset_id(id))
                .ok_or("epi-i18n:diagnostic.invalidPresetId")?;
            if !processed.insert(id) {
                continue;
            }
            let old = before.iter().find(|item| item["id"].as_str() == Some(id));
            let new = after.iter().find(|item| item["id"].as_str() == Some(id));
            if old == new {
                continue;
            }
            let path = root.join(folder).join(format!("{id}.json"));
            let stored = read_json(&path)?;
            if stored.as_ref() == new {
                continue;
            }
            let conflict = "epi-i18n:diagnostic.aConfigurationHasBeenModifiedReload";
            if stored.as_ref() != old {
                return Err(conflict.into());
            }
            if let Some(new) = new {
                if !save_json(root, &path, new, old.is_some())? {
                    return Err(conflict.into());
                }
            } else {
                delete_file(root, &path)?;
            }
        }
    }
    Ok(())
}

fn save_preferences(root: &Path, session: &Value, previous: &Value) -> Result<(), String> {
    if let Some(profiles) = session["profilePreferences"].as_object() {
        for (profile, prefs) in profiles.iter().filter(|(profile, _)| !profile.is_empty()) {
            let path = profile_prefs_path(root, profile);
            if prefs != &previous["profilePreferences"][profile]
                || !path.try_exists().map_err(message)?
            {
                save_json(root, &path, prefs, true)?;
            }
        }
    }
    update_global_preferences(root, |global| {
        global.retain(|key, _| key == "window");
        for key in [
            "selectedProfile",
            "pending",
            "addressFilter",
            "anonymousPreferences",
        ] {
            global.insert(key.into(), session[key].clone());
        }
    })
}

fn valid_extra_path(path: &str) -> bool {
    if !safe_path(path) {
        return false;
    }
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["interface.json" | "session.json" | "transactions.index"] | ["prefs", "global.json"] => {
            true
        }
        ["prefs", name] => {
            (name.starts_with("profil-") || name.starts_with("profil~")) && name.ends_with(".json")
        }
        ["prefs", "measurements" | "measurement-details", name] | ["notifications", name] => {
            name.ends_with(".json")
        }
        ["transactions" | "transactions.incoming" | "transactions.sent", name] => {
            transactions::filename_uuid(name).is_some()
        }
        _ => false,
    }
}

pub(crate) fn valid_transaction_path(path: &str) -> bool {
    (valid_file(path) || valid_extra_path(path))
        && path != "transactions.index"
        && !path.starts_with("transactions")
}

fn snapshot_files(root: &Path) -> Result<Vec<DataFile>, String> {
    let mut files = dataset_files(root)?;
    for folder in [
        "",
        "prefs",
        "prefs/measurements",
        "prefs/measurement-details",
        "notifications",
        "transactions",
        "transactions.incoming",
        "transactions.sent",
    ] {
        let directory = root.join(folder);
        if !folder.is_empty()
            && fs::symlink_metadata(&directory).is_ok_and(|meta| meta.is_symlink())
        {
            continue;
        }
        for entry in entries(&directory)? {
            if !entry.file_type().map_err(message)?.is_file() {
                continue;
            }
            let path = format!("{folder}/{}", entry.file_name().to_string_lossy());
            let path = path.trim_start_matches('/');
            if valid_extra_path(path) {
                files.push(DataFile {
                    path: path.into(),
                    contents: fs::read_to_string(entry.path()).map_err(message)?,
                });
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub fn export_files(app: AppHandle) -> Result<Vec<DataFile>, String> {
    snapshot_files(&data_root(&app)?)
}

fn merge_snapshot(root: &Path, files: Vec<DataFile>) -> Result<usize, String> {
    let mut dataset = Vec::new();
    let mut extras = Vec::new();
    let mut history = Vec::new();
    let mut ids = HashSet::new();
    for file in files {
        if !valid_file(&file.path) && !valid_extra_path(&file.path) {
            return Err(format!(
                "epi-i18n:diagnostic.invalidDataPath · {}",
                file.path
            ));
        }
        let mut target = root.to_path_buf();
        for part in file.path.split('/') {
            target.push(part);
            if fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_symlink()) {
                return Err(format!(
                    "epi-i18n:diagnostic.unexpectedSymbolicLink · {}",
                    file.path
                ));
            }
        }
        if valid_file(&file.path) {
            dataset.push(file);
        } else if file.path == "transactions.index" {
            ids.extend(transaction_index::parse(&file.contents).map_err(message)?);
        } else {
            let value: Value = serde_json::from_str(file.contents.trim_start_matches('\u{feff}'))
                .map_err(message)?;
            if file.path.starts_with("transactions") {
                let (_, name) = file.path.split_once('/').unwrap();
                let uuid = transactions::filename_uuid(name).unwrap();
                if value["uuid"].as_str() != Some(uuid.to_string().as_str()) {
                    return Err(format!(
                        "epi-i18n:diagnostic.invalidTransactionUuid · {}",
                        file.path
                    ));
                }
                let complete = !file.path.starts_with("transactions.incoming/");
                if complete {
                    ids.insert(uuid);
                }
                history.push((file, uuid, complete));
            } else {
                if !value.is_object() {
                    return Err(format!(
                        "epi-i18n:diagnostic.expectedJsonObjectAtPath · {}",
                        file.path
                    ));
                }
                extras.push((file, value));
            }
        }
    }
    let mut count = merge_files(root, dataset)?;
    for (file, value) in extras {
        if save_file(
            root,
            &root.join(&file.path),
            file.contents.as_bytes(),
            &value,
            false,
        )? {
            count += 1;
        }
    }
    let mut index = transaction_index::load(root).map_err(message)?;
    for (file, uuid, complete) in history {
        if !complete && (ids.contains(&uuid) || index.contains(&uuid)) {
            continue;
        }
        if atomic_write(&root.join(&file.path), file.contents.as_bytes(), false)? {
            count += 1;
        }
    }
    for uuid in ids {
        if index.insert(uuid) {
            transaction_index::add(root, uuid).map_err(message)?;
        }
    }
    Ok(count)
}

fn import_identity(file: &DataFile, row: &Value) -> (&'static str, Option<String>) {
    if file.path.starts_with("profiles/") {
        ("profiles", name(row).map(str::to_lowercase))
    } else {
        ("devices", address(row).map(str::to_ascii_uppercase))
    }
}

fn merge_files(root: &Path, files: Vec<DataFile>) -> Result<usize, String> {
    let imported = files
        .iter()
        .map(|entry| {
            if !valid_file(&entry.path) {
                return Err(format!(
                    "epi-i18n:diagnostic.invalidDataPath · {}",
                    entry.path
                ));
            }
            record(entry)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let existing = dataset_files(root)?;
    let mut paths: HashSet<_> = existing
        .iter()
        .map(|entry| entry.path.to_lowercase())
        .collect();
    let mut contents: HashSet<_> = existing
        .iter()
        .map(|entry| entry.contents.as_str())
        .collect();
    let mut identities = HashSet::new();
    let mut legacy_keys = HashSet::new();
    let mut profiles = Vec::new();
    let mut measurements = Vec::new();
    for file in &existing {
        let row = record(file)?;
        if file.path.starts_with("measures/") {
            measurements.push(row);
        } else {
            let (kind, legacy) = import_identity(file, &row);
            if let Some(id) = record_uuid(&row) {
                identities.insert((kind, id.to_ascii_lowercase()));
            }
            if let Some(key) = legacy {
                legacy_keys.insert((kind, key));
            }
            if kind == "profiles" {
                profiles.push(row);
            }
        }
    }
    let mut count = 0;
    for (entry, row) in files
        .iter()
        .zip(&imported)
        .filter(|(file, _)| !file.path.starts_with("measures/"))
    {
        let path = entry.path.to_lowercase();
        let (kind, legacy) = import_identity(entry, row);
        let identity = record_uuid(row).map(|id| (kind, id.to_ascii_lowercase()));
        let legacy = legacy.map(|key| (kind, key));
        if paths.contains(&path)
            || contents.contains(entry.contents.as_str())
            || identity
                .as_ref()
                .is_some_and(|key| identities.contains(key))
            || legacy.as_ref().is_some_and(|key| legacy_keys.contains(key))
        {
            continue;
        }
        let value =
            serde_json::from_str(entry.contents.trim_start_matches('\u{feff}')).map_err(message)?;
        if save_file(
            root,
            &root.join(&entry.path),
            entry.contents.as_bytes(),
            &value,
            false,
        )? {
            count += 1;
            paths.insert(path);
            contents.insert(&entry.contents);
            identities.extend(identity);
            legacy_keys.extend(legacy);
            if kind == "profiles" {
                profiles.push(row.clone());
            }
        }
    }
    let mut occupied: HashSet<_> = measurements
        .iter()
        .filter_map(|row| measurement_path(row, &profiles).ok())
        .collect();
    for (entry, row) in files
        .iter()
        .zip(&imported)
        .filter(|(file, _)| file.path.starts_with("measures/"))
    {
        let path = entry.path.to_lowercase();
        let slot = measurement_path(row, &profiles)?;
        if paths.contains(&path) || occupied.contains(&slot) || !valid_file(&slot) {
            continue;
        }
        let value =
            serde_json::from_str(entry.contents.trim_start_matches('\u{feff}')).map_err(message)?;
        if save_file(
            root,
            &root.join(&entry.path),
            entry.contents.as_bytes(),
            &value,
            false,
        )? {
            count += 1;
            paths.insert(path);
            occupied.insert(slot);
        }
    }
    Ok(count)
}

#[tauri::command]
pub fn import_files(app: AppHandle, files: Vec<DataFile>) -> Result<usize, String> {
    merge_snapshot(&data_root(&app)?, files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(desktop)]
    #[test]
    fn walks_up_from_the_executable_and_skips_incomplete_data_directories() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let release = project.join("release/windows");
        fs::create_dir_all(release.join("data/profiles")).unwrap();
        for folder in ["profiles", "devices", "measures"] {
            fs::create_dir_all(project.join("data").join(folder)).unwrap();
        }
        assert_eq!(shared_data(&release), Some(project.join("data")));
        assert_eq!(shared_data(root.path()), None);
    }

    #[test]
    fn notifications_round_trip_individually_and_rollback_on_failed_save() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let id = "bfa95fcb-0a16-40dc-852e-a940887ae76e";
        let row = json!({ "id": id, "date": "2026-01-02T00:00:00.000Z", "type": "profile", "action": "deleted",
            "record": { "name": "Alice" }, "measurements": [{ "receivedAt": "2026-01-01" }] });
        let state = json!({ "notifications": [row] });
        let empty = json!({});
        let path = notification_path(root, id).unwrap();

        let result = with_notifications(root, &state, &empty, || Err("Échec".into()));
        assert!(result.is_err());
        assert!(!path.exists());

        with_notifications(root, &state, &empty, || Ok(())).unwrap();
        assert_eq!(read_json(&path).unwrap(), Some(row));
        assert_eq!(
            read_session(root).unwrap()["notifications"],
            state["notifications"]
        );

        with_notifications(root, &empty, &state, || Ok(())).unwrap();
        assert!(!path.exists());
        assert_eq!(read_session(root).unwrap()["notifications"], json!([]));

        let mut stale = state.clone();
        stale["notifications"][0]["restored"] = json!(true);
        assert!(with_notifications(root, &stale, &state, || Ok(())).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn deletions_persist_and_reject_stale_measurements() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        let profile = json!({ "name": "Alice" });
        let profile_file = path.join("profiles/profil-alice.json");
        let prefs_file = profile_prefs_path(path, "Alice");
        json_write(&profile_file, &profile, false).unwrap();
        json_write(&prefs_file, &json!({ "theme": "dark" }), false).unwrap();
        let device_file = path.join("devices/scale.json");
        json_write(&device_file, &json!({ "name": "Scale" }), false).unwrap();
        let first = path.join("measures/alice/first.json");
        let second = path.join("measures/alice/second.json");
        let other = path.join("measures/bob/first.json");
        let reading =
            |name, weight| json!({ "profile": { "name": name }, "measures": { "weight": weight } });
        json_write(&first, &reading("Alice", 60.0), false).unwrap();
        json_write(&second, &reading("Alice", 61.0), false).unwrap();
        json_write(&other, &reading("Bob", 62.0), false).unwrap();

        let mut before = read_session(path).unwrap();
        before["measurements"][0]["measures"]["weight"] = json!(60);
        let mut after = before.clone();
        after["measurements"].as_array_mut().unwrap().remove(0);
        save_deletion(path, &after, &before).unwrap();
        assert!(!first.exists());
        assert!(second.exists());

        let before = read_session(path).unwrap();
        let mut after = before.clone();
        after["devices"] = json!([]);
        save_deletion(path, &after, &before).unwrap();
        assert!(!device_file.exists());
        assert!(second.exists());

        let before = read_session(path).unwrap();
        let mut after = before.clone();
        after["profiles"] = json!([]);
        after["profilePreferences"] = json!({});
        after["measurements"].as_array_mut().unwrap().remove(0);
        json_write(&first, &reading("Alice", 63.0), false).unwrap();
        assert!(save_deletion(path, &after, &before).is_err());
        assert!(profile_file.exists());
        assert!(second.exists());
        fs::remove_file(first).unwrap();
        save_deletion(path, &after, &before).unwrap();
        assert!(!profile_file.exists());
        assert!(!prefs_file.exists());
        assert!(!second.parent().unwrap().exists());
        assert!(other.exists());
    }

    #[test]
    fn deleted_profile_preferences_survive_reload_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let id = "bfa95fcb-0a16-40dc-852e-a940887ae76e";
        let profile = json!({ "name": "Alice", "uuid": id });
        let prefs = json!({ "theme": "dark", "columns": ["bmi", "fatPercent"] });
        let prefs_path = profile_prefs_path(root, "Alice");
        let initial = json!({ "profiles": [profile], "profilePreferences": { "Alice": prefs } });
        save_dataset(root, &initial, &json!({})).unwrap();

        let before = read_session(root).unwrap();
        let mut deleted = before.clone();
        deleted["profiles"] = json!([]);
        deleted["profilePreferences"] = json!({});
        deleted["notifications"] = json!([{
            "id": id, "date": "2026-01-02T00:00:00.000Z", "type": "profile", "action": "deleted",
            "record": before["profiles"][0], "preferences": before["profilePreferences"]["Alice"],
        }]);
        with_notifications(root, &deleted, &before, || {
            save_dataset(root, &deleted, &before)
        })
        .unwrap();
        assert!(!prefs_path.exists());

        let reopened = read_session(root).unwrap();
        let entry = &reopened["notifications"][0];
        assert_eq!(entry["preferences"], prefs);
        let mut restored = reopened.clone();
        restored["profiles"] = json!([entry["record"]]);
        restored["profilePreferences"]["Alice"] = entry["preferences"].clone();
        save_dataset(root, &restored, &reopened).unwrap();

        assert_eq!(read_json(&prefs_path).unwrap(), Some(prefs.clone()));
        assert_eq!(
            read_session(root).unwrap()["profilePreferences"]["Alice"],
            prefs
        );
    }

    #[cfg(desktop)]
    #[test]
    fn window_and_session_updates_preserve_each_others_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let legacy = json!({ "selectedProfile": "Alice", "pending": true });
        json_write(&root.join(LEGACY_PREFS), &legacy, true).unwrap();

        let window = json!({ "position": { "x": -300, "y": 100 }, "maximized": true });
        save_window_preferences(root, window.clone()).unwrap();
        assert_eq!(
            read_global_preferences(root).unwrap()["selectedProfile"],
            "Alice"
        );

        let session = json!({ "selectedProfile": "Bob" });
        save_preferences(root, &session, &legacy).unwrap();
        assert_eq!(read_window_preferences(root).unwrap(), window);

        save_window_preferences(root, json!({ "minimized": true })).unwrap();
        assert_eq!(
            read_global_preferences(root).unwrap()["selectedProfile"],
            "Bob"
        );
    }

    #[test]
    fn profile_preferences_and_last_profile_are_stored_separately() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for profile in ["Alice", "Bob"] {
            json_write(
                &root.join(format!("profiles/profil-{profile}.json")),
                &json!({ "name": profile }),
                true,
            )
            .unwrap();
        }
        let old = json!({ "selectedProfile": "Alice", "columns": ["fatPercent"] });
        json_write(&root.join(LEGACY_PREFS), &old, true).unwrap();
        assert_eq!(read_session(root).unwrap()["columns"], old["columns"]);

        let preferences = json!({
            "Alice": { "columns": ["fatPercent"], "splitColumns": ["fatPercent"] },
            "Bob": { "columns": [] }
        });
        let session = json!({ "selectedProfile": "Bob", "profilePreferences": preferences });
        save_preferences(root, &session, &session).unwrap();
        let reopened = read_session(root).unwrap();
        assert_eq!(reopened["selectedProfile"], "Bob");
        assert_eq!(reopened["profilePreferences"], preferences);
        assert!(reopened.get("columns").is_none());
        assert!(root.join("prefs/profil-Alice.json").is_file());
        assert!(root.join("prefs/profil-Bob.json").is_file());
    }

    #[test]
    fn view_presets_use_separate_folders_and_keep_their_uuid_on_rename() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let id = "a2788c87-ab0a-44f7-aeea-6e3d37442ae7";
        let empty = json!({});
        let mut presets = json!({
            "measurements": [{ "id": id, "name": "Compact", "layout": { "columns": [] } }],
            "details": [{ "id": id, "name": "Comparaison", "layout": { "detailSectionOrder": ["device"] } }],
        });
        save_view_presets(root, &presets, &empty).unwrap();
        assert_eq!(read_session(root).unwrap()["viewPresets"], presets);
        assert!(root.join(format!("prefs/measurements/{id}.json")).is_file());
        assert!(root
            .join(format!("prefs/measurement-details/{id}.json"))
            .is_file());

        let previous = presets.clone();
        presets["measurements"][0]["name"] = json!("Rapide");
        presets["details"] = json!([]);
        save_view_presets(root, &presets, &previous).unwrap();
        save_view_presets(root, &presets, &previous).unwrap();
        assert_eq!(read_session(root).unwrap()["viewPresets"], presets);
    }

    #[test]
    fn merge_keeps_existing_paths_and_skips_identical_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        let file = |path: &str, name: &str| DataFile {
            path: path.into(),
            contents: format!(r#"{{"name":"{name}"}}"#),
        };
        assert_eq!(
            merge_files(path, vec![file("profiles/profil-anna.json", "Anna")]).unwrap(),
            1
        );
        let added = merge_files(
            path,
            vec![
                file("profiles/profil-anna.json", "Replacement"),
                file("profiles/profil-duplicate.json", "Anna"),
                file("profiles/profil-luc.json", "Luc"),
            ],
        )
        .unwrap();
        assert_eq!(added, 1);
        assert_eq!(
            read_session(path).unwrap()["profiles"],
            json!([{"name":"Anna"},{"name":"Luc"}])
        );
        assert!(merge_files(path, vec![file("profiles/../outside.json", "Invalid")]).is_err());
    }

    #[test]
    fn snapshot_roundtrip_restores_preferences_notifications_and_transaction_history() {
        let origin = tempfile::tempdir().unwrap();
        let replica = tempfile::tempdir().unwrap();
        let root = origin.path();
        let prefs = json!({"theme": "dark"});
        let notification = "notifications/a2788c87-ab0a-44f7-aeea-6e3d37442ae7.json";
        save_json(root, &root.join(PREFS), &prefs, false).unwrap();
        save_json(
            root,
            &root.join(notification),
            &json!({"date": "2026-11-15"}),
            false,
        )
        .unwrap();
        let pending_uuid = "bfa95fcb-0a16-40dc-852e-a940887ae76e";
        let pending_path =
            format!("transactions.incoming/2026-11-15T06-47-43.567000Z-{pending_uuid}.json");
        let pending = json!({"uuid": pending_uuid, "type":"delete","data":{"path": notification}});
        json_write(&root.join(&pending_path), &pending, false).unwrap();
        let snapshot = snapshot_files(root).unwrap();
        assert_eq!(snapshot.len(), 6);
        assert_eq!(merge_snapshot(replica.path(), snapshot).unwrap(), 5);
        assert_eq!(
            merge_snapshot(replica.path(), snapshot_files(root).unwrap()).unwrap(),
            0
        );
        assert_eq!(read_json(&replica.path().join(PREFS)).unwrap(), Some(prefs));
        assert!(replica.path().join(notification).is_file());
        assert_eq!(
            read_json(&replica.path().join(pending_path)).unwrap(),
            Some(pending)
        );
        assert!(transaction_index::load(root)
            .unwrap()
            .is_subset(&transaction_index::load(replica.path()).unwrap()));
    }

    #[test]
    fn zip_import_keeps_existing_measurement_across_path_and_timezone_formats() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let uuid = "bfa95fcb-0a16-40dc-852e-a940887ae76e";
        let original = json!({
            "receivedAt": "2026-11-15T06:47:43.567Z",
            "profile": { "name": "Lou", "uuid": uuid },
            "measures": { "weight": 61.0, "unit": "kg" },
        });
        let existing = root.join("measures/lou/2026-11-15-06-47-43.json");
        json_write(&existing, &original, false).unwrap();
        let mut incoming = original.clone();
        incoming["profile"]["name"] = json!("Louise");
        incoming["receivedAt"] = json!("2026-11-15T07:47:43.567+01:00");
        incoming["measures"]["weight"] = json!(75.0);
        let path = format!("measures/{uuid}/2026-11-15T06-47-43.567Z.json");
        assert_eq!(
            merge_files(
                root,
                vec![DataFile {
                    path,
                    contents: incoming.to_string()
                }]
            )
            .unwrap(),
            0
        );
        assert_eq!(read_json(&existing).unwrap(), Some(original));
        assert_eq!(dataset_files(root).unwrap().len(), 1);
    }

    #[test]
    fn migrates_existing_measurements_in_place_without_merging_identical_files() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("measures/alice/first.json");
        let second = dir.path().join("measures/alice/second.json");
        let old = json!({ "receivedAt": "2026-01-01T12:00:00Z", "profile": { "name": "Alice" } });
        json_write(&first, &old, false).unwrap();
        json_write(&second, &old, false).unwrap();
        let before = [old.clone(), old.clone()];
        let mut after = [old.clone(), old];
        after[0]["uuid"] = json!("a");
        after[1]["uuid"] = json!("b");

        save_measurements(dir.path(), &after, &before, &[]).unwrap();
        save_measurements(dir.path(), &after, &before, &[]).unwrap();
        assert_eq!(read_json(&first).unwrap(), Some(after[0].clone()));
        assert_eq!(read_json(&second).unwrap(), Some(after[1].clone()));
    }

    #[test]
    fn immutable_measurements_keep_the_existing_timestamp_on_collision() {
        let root = tempfile::tempdir().unwrap();
        let reading = |weight: f64| json!({"receivedAt":"2026-11-14T12:01:03.000Z","profile":{"name":"Élodie"},"measures":{"weight":weight,"unit":"kg"}});
        let readings = [reading(61.1), reading(62.0)];
        save_measurements(root.path(), &readings, &[], &[]).unwrap();
        save_measurements(root.path(), &readings, &[], &[]).unwrap();
        let files = dataset_files(root.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].path,
            "measures/élodie/2026-11-14T12-01-03.000Z.json"
        );
        assert_eq!(record(&files[0]).unwrap(), readings[0]);
    }
}
