use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const PREFS: &str = "prefs/global.json";
const LEGACY_PREFS: &str = "interface.json";

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

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(desktop)]
    {
        if let Some(path) = std::env::var_os("EPI_DATA_DIR").filter(|path| !path.is_empty()) {
            return Ok(PathBuf::from(path));
        }
        // An AppImage runs its ELF from a temporary mount. APPIMAGE points to the original file.
        #[cfg(target_os = "linux")]
        let executable = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file())
            .or_else(|| std::env::current_exe().ok());
        #[cfg(not(target_os = "linux"))]
        let executable = std::env::current_exe().ok();
        if let Some(shared) = executable.as_deref().and_then(Path::parent).and_then(shared_data) {
            return Ok(shared);
        }
    }
    let private = app.path().app_data_dir().map_err(message)?.join("data");
    #[cfg(desktop)]
    for folder in ["devices", "measures", "profiles"] {
        fs::create_dir_all(private.join(folder)).map_err(message)?;
    }
    Ok(private)
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

fn valid_file(file: &str) -> bool {
    let parts: Vec<_> = file.split('/').collect();
    if parts.iter().any(|name| {
        name.is_empty()
            || name.starts_with('.')
            || name.ends_with('.')
            || name.ends_with(' ')
            || name.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
            || name.chars().any(char::is_control)
            || reserved(name.split('.').next().unwrap_or_default())
    }) {
        return false;
    }
    match parts.as_slice() {
        ["profiles", name] => {
            name.starts_with("profil-") && name.ends_with(".json") && name.len() > 12
        }
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

fn safe_name(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.starts_with(|c: char| !c.is_alphanumeric())
        || !value
            .chars()
            .all(|c| c.is_alphanumeric() || " _-".contains(c))
    {
        Err("Nom incompatible avec le dossier data.".into())
    } else {
        Ok(value)
    }
}

fn record(file: &DataFile) -> Result<Value, String> {
    let mut row: Value = serde_json::from_str(file.contents.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("{} · {error}", file.path))?;
    if !row.is_object() {
        return Err(format!("{} · objet JSON attendu", file.path));
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

fn read_session(root: &Path) -> Result<Value, String> {
    let mut session = match read_json(&root.join(PREFS))? {
        Some(prefs) => prefs,
        None => read_json(&root.join(LEGACY_PREFS))?.unwrap_or_else(|| json!({})),
    };
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
    session["profiles"] = json!(profiles);
    session["devices"] = json!(devices);
    session["measurements"] = json!(measurements);
    Ok(session)
}

fn atomic_write(path: &Path, data: &[u8], replace: bool) -> Result<bool, String> {
    let root = path.parent().ok_or("Dossier de données introuvable.")?;
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
    new_path: impl Fn(&Value) -> Result<String, String>,
) -> Result<(), String> {
    let old: HashMap<_, _> = rows(previous, key)
        .iter()
        .filter_map(|row| Some((identity(row)?, row)))
        .collect();
    let mut files = HashMap::new();
    let folder = format!("{key}/");
    for file in dataset_files(root)?
        .into_iter()
        .filter(|file| file.path.starts_with(&folder))
    {
        let row = record(&file)?;
        if let Some(id) = identity(&row) {
            files.insert(id.to_owned(), file.path);
        }
    }
    for row in rows(state, key) {
        let id = identity(row).ok_or("Fiche sans identifiant.")?;
        if old.get(id).is_some_and(|old| *old == row) {
            continue;
        }
        let existing_path = files.get(id);
        if let Some(existing) = existing_path {
            let current = record(&DataFile {
                path: existing.clone(),
                contents: fs::read_to_string(root.join(existing)).map_err(message)?,
            })?;
            if &current == row {
                continue;
            }
            if old.get(id).is_none_or(|old| *old != &current) {
                return Err(
                    "Une fiche a été modifiée. Recharge les données avant de réessayer.".into(),
                );
            }
        }
        let path = match existing_path {
            Some(path)
                if key != "devices" || old.get(id).is_some_and(|old| name(old) == name(row)) =>
            {
                path.clone()
            }
            _ => new_path(row)?,
        };
        if !valid_file(&path) {
            return Err("Nom de fichier incompatible.".into());
        }
        let replace = existing_path.is_some_and(|existing| existing.eq_ignore_ascii_case(&path));
        let target = root.join(if replace {
            existing_path.unwrap()
        } else {
            &path
        });
        if !json_write(&target, row, replace)? {
            return Err("Une fiche existe déjà. Recharge les données avant de réessayer.".into());
        }
        if let Some(existing) = existing_path.filter(|_| !replace) {
            if let Err(error) = fs::remove_file(root.join(existing)) {
                let _ = fs::remove_file(&target);
                return Err(message(error));
            }
        }
    }
    Ok(())
}

fn save_measurements(root: &Path, new: &[Value], previous: &[Value]) -> Result<(), String> {
    for row in new.iter().skip(previous.len()) {
        let folder = match row["profile"]["name"].as_str() {
            Some(name) => {
                let name = safe_name(name)?.to_lowercase();
                if reserved(&name) {
                    format!("_{name}")
                } else {
                    name
                }
            }
            None => "_sans-profil".into(),
        };
        let received = row["receivedAt"].as_str().unwrap_or_default();
        let stamp = received
            .get(..19)
            .filter(|stamp| {
                stamp
                    .bytes()
                    .all(|ch| ch.is_ascii_digit() || b"T-:".contains(&ch))
            })
            .ok_or("Date de pesée invalide.")?
            .replace(['T', ':'], "-");
        for sequence in 1.. {
            let suffix = if sequence == 1 {
                String::new()
            } else {
                format!("-{sequence}")
            };
            let path = format!("measures/{folder}/{stamp}{suffix}.json");
            if !valid_file(&path) {
                return Err("Chemin de pesée invalide.".into());
            }
            let path = root.join(path);
            if json_write(&path, row, false)? {
                break;
            }
            if let Ok(contents) = fs::read(&path) {
                if serde_json::from_slice::<Value>(&contents).is_ok_and(|existing| &existing == row)
                {
                    break;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn load_session(app: AppHandle) -> Result<Value, String> {
    read_session(&data_root(&app)?)
}

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    session: Value,
    previous: Value,
    device_paths: Value,
) -> Result<(), String> {
    let root = data_root(&app)?;
    if session["profiles"] != previous["profiles"] {
        save_records(&root, &session, &previous, "profiles", name, |row| {
            Ok(format!(
                "profiles/profil-{}.json",
                safe_name(name(row).ok_or("Profil sans nom.")?)?.to_lowercase()
            ))
        })?;
    }
    if session["devices"] != previous["devices"] {
        save_records(&root, &session, &previous, "devices", address, |row| {
            let address = address(row).ok_or("Appareil sans adresse.")?;
            let path = device_paths[address]
                .as_str()
                .ok_or("Fichier appareil manquant.")?;
            Ok(format!("devices/{path}.json"))
        })?;
    }
    save_measurements(
        &root,
        rows(&session, "measurements"),
        rows(&previous, "measurements"),
    )?;
    save_preferences(&root, &session, &previous)
}

fn save_preferences(root: &Path, session: &Value, previous: &Value) -> Result<(), String> {
    if let Some(profiles) = session["profilePreferences"].as_object() {
        for (profile, prefs) in profiles.iter().filter(|(profile, _)| !profile.is_empty()) {
            let path = profile_prefs_path(root, profile);
            if prefs != &previous["profilePreferences"][profile]
                || !path.try_exists().map_err(message)?
            {
                json_write(&path, prefs, true)?;
            }
        }
    }
    let global = json!({
        "selectedProfile": session["selectedProfile"],
        "pending": session["pending"],
        "addressFilter": session["addressFilter"],
    });
    json_write(&root.join(PREFS), &global, true)?;
    Ok(())
}

#[tauri::command]
pub fn export_files(app: AppHandle) -> Result<Vec<DataFile>, String> {
    dataset_files(&data_root(&app)?)
}

fn merge_files(root: &Path, files: Vec<DataFile>) -> Result<usize, String> {
    for entry in &files {
        if !valid_file(&entry.path) {
            return Err(format!("Chemin de données invalide · {}", entry.path));
        }
        record(entry)?;
    }
    let existing = dataset_files(root)?;
    let mut paths: HashSet<_> = existing
        .iter()
        .map(|entry| entry.path.to_lowercase())
        .collect();
    let mut contents: HashSet<_> = existing
        .iter()
        .map(|entry| entry.contents.as_str())
        .collect();
    let mut count = 0;
    for entry in &files {
        let key = entry.path.to_lowercase();
        if paths.contains(&key) || contents.contains(entry.contents.as_str()) {
            continue;
        }
        if atomic_write(&root.join(&entry.path), entry.contents.as_bytes(), false)? {
            count += 1;
            paths.insert(key);
            contents.insert(&entry.contents);
        }
    }
    Ok(count)
}

#[tauri::command]
pub fn import_files(app: AppHandle, files: Vec<DataFile>) -> Result<usize, String> {
    merge_files(&data_root(&app)?, files)
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
    fn immutable_measurements_allocate_colliding_timestamps_and_survive_retry() {
        let root = tempfile::tempdir().unwrap();
        let reading = |weight: f64| json!({"receivedAt":"2026-11-14T12:01:03.000Z","profile":{"name":"Élodie"},"measures":{"weight":weight,"unit":"kg"}});
        let readings = [reading(61.1), reading(62.0)];
        save_measurements(root.path(), &readings, &[]).unwrap();
        save_measurements(root.path(), &readings, &[]).unwrap();
        let files = dataset_files(root.path()).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .any(|file| file.path == "measures/élodie/2026-11-14-12-01-03-2.json"));
    }
}
