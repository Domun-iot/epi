use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use uuid::Uuid;

const BUSY: &str = "installation_busy";
const GRACE: Duration = Duration::from_secs(30);
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct Owner {
    pid: u32,
    token: String,
}
thread_local! { static HELD: RefCell<HashMap<PathBuf, (String, usize)>> = RefCell::new(HashMap::new()); }
fn owner(path: &Path) -> Result<Option<Owner>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(BUSY.into()),
    }
}
fn old(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| SystemTime::now().duration_since(time).ok())
        .is_some_and(|age| age > GRACE)
}
#[cfg(windows)]
fn alive(pid: u32) -> bool {
    if pid == 0 {
        return true;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn WaitForSingleObject(handle: *mut std::ffi::c_void, timeout: u32) -> u32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        fn GetLastError() -> u32;
    }
    // SYNCHRONIZE is sufficient to check whether the process exited.
    unsafe {
        let handle = OpenProcess(0x00100000, 0, pid);
        if handle.is_null() {
            return GetLastError() != 87;
        }
        let result = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        result != 0
    }
}
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if pid == 0 || pid > i32::MAX as u32 {
        return true;
    }
    unsafe { kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() != Some(3) }
}
fn write_owner(path: &Path, value: &Owner) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| BUSY.to_owned())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}
fn reclaim(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| BUSY.to_owned())?;
    if !meta.is_dir() || meta.is_symlink() {
        return Err(BUSY.into());
    }
    let owner_file = path.join("owner.json");
    let previous = owner(&owner_file)?;
    let orphan_old = old(path);
    if previous
        .as_ref()
        .map_or(!orphan_old, |value| alive(value.pid))
    {
        return Err(BUSY.into());
    }
    let recovery_file = path.join("recovery.json");
    let old_recovery = owner(&recovery_file)?;
    if let Some(recovery) = &old_recovery {
        if alive(recovery.pid) || owner(&recovery_file)? != old_recovery {
            return Err(BUSY.into());
        }
        fs::remove_file(&recovery_file).map_err(|_| BUSY.to_owned())?;
    } else if recovery_file.exists() {
        if !old(&recovery_file) {
            return Err(BUSY.into());
        }
        fs::remove_file(&recovery_file).map_err(|_| BUSY.to_owned())?;
    }
    let recovery = Owner {
        pid: std::process::id(),
        token: Uuid::new_v4().to_string(),
    };
    write_owner(&recovery_file, &recovery)?;
    let result = (|| {
        let current = owner(&owner_file)?;
        if current != previous
            || current
                .as_ref()
                .map_or(!orphan_old, |value| alive(value.pid))
            || owner(&recovery_file)?.as_ref() != Some(&recovery)
        {
            return Err(BUSY.to_owned());
        }
        let quarantine =
            path.with_file_name(format!(".installation.lock.recovered-{}", recovery.token));
        fs::rename(path, &quarantine).map_err(|_| BUSY.to_owned())?;
        fs::remove_dir_all(quarantine).map_err(|e| e.to_string())
    })();
    if result.is_err() && owner(&recovery_file).ok().flatten().as_ref() == Some(&recovery) {
        let _ = fs::remove_file(recovery_file);
    }
    result
}
pub(crate) struct InstallationLock {
    key: PathBuf,
    path: PathBuf,
    token: String,
}
impl Drop for InstallationLock {
    fn drop(&mut self) {
        let release = HELD.with(|held| {
            let mut held = held.borrow_mut();
            let Some((_, count)) = held.get_mut(&self.key) else {
                return false;
            };
            *count -= 1;
            if *count == 0 {
                held.remove(&self.key);
                true
            } else {
                false
            }
        });
        if release {
            let expected = Owner {
                pid: std::process::id(),
                token: self.token.clone(),
            };
            if owner(&self.path.join("owner.json")).ok().flatten().as_ref() == Some(&expected) {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }
}
pub(crate) fn acquire(root: &Path) -> Result<InstallationLock, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let key = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let path = key.join(".installation.lock");
    if let Some(token) = HELD.with(|held| {
        let mut held = held.borrow_mut();
        held.get_mut(&key).map(|(token, count)| {
            *count += 1;
            token.clone()
        })
    }) {
        return Ok(InstallationLock { key, path, token });
    }
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            reclaim(&path)?;
            fs::create_dir(&path).map_err(|_| BUSY.to_owned())?;
        }
        Err(e) => return Err(e.to_string()),
    }
    let value = Owner {
        pid: std::process::id(),
        token: Uuid::new_v4().to_string(),
    };
    if let Err(e) = write_owner(&path.join("owner.json"), &value) {
        let _ = fs::remove_dir(&path);
        return Err(e);
    }
    HELD.with(|held| {
        held.borrow_mut()
            .insert(key.clone(), (value.token.clone(), 1));
    });
    Ok(InstallationLock {
        key,
        path,
        token: value.token,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_guards_release_only_the_outer_owner_and_recover_dead_pid() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let first = acquire(root).unwrap();
        let second = acquire(root).unwrap();
        drop(second);
        assert!(root.join(".installation.lock").exists());
        drop(first);
        assert!(!root.join(".installation.lock").exists());
        fs::create_dir(root.join(".installation.lock")).unwrap();
        write_owner(
            &root.join(".installation.lock/owner.json"),
            &Owner {
                pid: i32::MAX as u32,
                token: Uuid::new_v4().to_string(),
            },
        )
        .unwrap();
        let recovered = acquire(root).unwrap();
        drop(recovered);
        assert!(!root.join(".installation.lock").exists());
    }
    #[test]
    fn a_node_writer_prevents_a_native_account_switch_until_release() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let dir = tempfile::tempdir().unwrap();
        let module =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shared/installation-lock.cjs");
        let mut command = Command::new("node");
        command.args(["-e", "const release = require(process.argv[1]).acquireInstallationLock(process.argv[2]); console.log('locked'); process.stdin.resume(); process.stdin.on('end', () => { release(); process.exit(0); });"])
            .arg(module).arg(dir.path()).stdin(Stdio::piped()).stdout(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "locked");
        assert_eq!(acquire(dir.path()).err().as_deref(), Some(BUSY));
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        let available = acquire(dir.path()).unwrap();
        drop(available);
    }
    #[test]
    fn a_second_thread_cannot_enter_a_live_owner() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let first = acquire(&root).unwrap();
        assert_eq!(
            std::thread::spawn(move || acquire(&root).err())
                .join()
                .unwrap(),
            Some(BUSY.to_owned())
        );
        drop(first);
    }
}
