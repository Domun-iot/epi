use std::{fmt::Write as _, sync::Mutex, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{AppHandle, Emitter};
use uuid::{uuid, Uuid};

#[cfg(target_os = "android")]
#[path = "bluetooth/android.rs"]
mod platform;
#[cfg(not(target_os = "android"))]
#[path = "bluetooth/native.rs"]
mod platform;

#[cfg(target_os = "android")]
pub use platform::set_foreground;

const COMPOSITION: Uuid = uuid!("0000181b-0000-1000-8000-00805f9b34fb");
const WEIGHT: Uuid = uuid!("0000181d-0000-1000-8000-00805f9b34fb");
const WEIGHT_MEASUREMENT: Uuid = uuid!("00002a9d-0000-1000-8000-00805f9b34fb");
const RETRY: Duration = Duration::from_secs(4);
// None means there is no scanner task running.
static SCAN_STATUS: Mutex<Option<String>> = Mutex::new(None);

/// Start the scanner or replay its current status to the reloaded webview.
pub fn start(app: AppHandle) {
    {
        let mut current = SCAN_STATUS.lock().unwrap();
        if let Some(message) = current.as_deref() {
            let _ = app.emit("ble-status", message);
            return;
        }
        *current = Some("Démarrage du Bluetooth…".to_owned());
    }
    tauri::async_runtime::spawn(async move {
        platform::run(&app).await;
        *SCAN_STATUS.lock().unwrap() = None;
    });
}

fn status(app: &AppHandle, message: &str) {
    // Serialize status updates with replays so a replay cannot overwrite a newer event.
    let mut current = SCAN_STATUS.lock().unwrap();
    *current = Some(message.to_owned());
    let _ = app.emit("ble-status", message);
}

struct Source {
    id: String,
    name: String,
    rssi: Option<i16>,
}

impl Source {
    fn new(id: &str, name: Option<&str>, rssi: Option<i16>) -> Self {
        Self {
            id: id.replace(':', "").to_ascii_uppercase(),
            name: STANDARD.encode(name.unwrap_or_default().as_bytes()),
            rssi,
        }
    }

    fn metadata(&self, app: &AppHandle, companies: impl Iterator<Item = u16>) {
        let mut companies: Vec<_> = companies.collect();
        companies.sort_unstable();
        companies.dedup();
        let companies: Vec<_> = companies.iter().map(|id| format!("{id:04X}")).collect();
        if !self.name.is_empty() || !companies.is_empty() {
            let _ = app.emit(
                "ble-frame",
                format!("META {} {} {}", self.id, self.name, companies.join(",")),
            );
        }
    }

    fn frame(&self, app: &AppHandle, service: &str, payload: &[u8], kind: &str) {
        if !(3..=15).contains(&payload.len()) {
            return;
        }
        let mut hex = String::with_capacity(payload.len() * 2);
        for byte in payload {
            let _ = write!(hex, "{byte:02X}");
        }
        let rssi = self
            .rssi
            .map_or_else(|| "-".to_owned(), |rssi| rssi.to_string());
        let _ = app.emit(
            "ble-frame",
            format!("{} {rssi} {service} {hex} {kind} {}", self.id, self.name),
        );
    }
}
