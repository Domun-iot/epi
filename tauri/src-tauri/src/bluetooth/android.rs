use std::{
    collections::HashMap,
    sync::LazyLock,
    time::{Duration, Instant},
};

use futures_util::{
    future::{select, Either},
    pin_mut,
};
use tauri::AppHandle;
use tauri_plugin_blec::{
    check_permissions, get_handler,
    models::{AdapterState, BleDevice, ScanFilter},
    Handler, OnDisconnectHandler,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

use super::{status, Source, COMPOSITION, RETRY, WEIGHT, WEIGHT_MEASUREMENT};

// Tauri skips the initial onResume event.
static FOREGROUND: LazyLock<watch::Sender<bool>> = LazyLock::new(|| watch::Sender::new(true));

pub fn set_foreground(active: bool) {
    FOREGROUND.send_if_modified(|current| {
        let changed = *current != active;
        *current = active;
        changed
    });
}

pub(super) async fn run(app: &AppHandle) {
    status(app, "Démarrage de l’écoute Bluetooth…");
    let handler = match wait_for_handler().await {
        Some(handler) => handler,
        None => {
            status(
                app,
                "Bluetooth indisponible · initialisation Android impossible",
            );
            return;
        }
    };
    let mut foreground = FOREGROUND.subscribe();
    let mut prompt = true;
    loop {
        let _ = foreground.wait_for(|active| *active).await;
        match check_permissions(prompt).await {
            Ok(true) => break,
            Ok(false) => status(
                app,
                "Autorise les appareils à proximité dans les paramètres Android",
            ),
            Err(error) => status(
                app,
                &format!("Autorisation Bluetooth indisponible · {error}"),
            ),
        }
        // Prompt once, then recover automatically after a settings change.
        prompt = false;
        retry_or_lifecycle_change(&mut foreground).await;
    }

    // Keep cached advertisements from replaying when the scan restarts.
    let mut previous_payloads = HashMap::new();
    loop {
        let _ = foreground.wait_for(|active| *active).await;
        if matches!(handler.get_adapter_state().await, AdapterState::Off) {
            status(
                app,
                "Bluetooth désactivé · active-le dans les paramètres Android",
            );
        } else if let Err(error) =
            scan(app, handler, foreground.clone(), &mut previous_payloads).await
        {
            status(app, &format!("Bluetooth indisponible · {error}"));
        }
        if !foreground.has_changed().unwrap_or(false) {
            retry_or_lifecycle_change(&mut foreground).await;
        }
    }
}

async fn retry_or_lifecycle_change(foreground: &mut watch::Receiver<bool>) {
    let change = foreground.changed();
    let delay = tokio::time::sleep(RETRY);
    pin_mut!(change, delay);
    let _ = select(change, delay).await;
}

async fn wait_for_handler() -> Option<&'static Handler> {
    for _ in 0..100 {
        if let Ok(handler) = get_handler() {
            return Some(handler);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

async fn scan(
    app: &AppHandle,
    handler: &'static Handler,
    mut foreground: watch::Receiver<bool>,
    previous_payloads: &mut HashMap<String, Vec<u8>>,
) -> tauri_plugin_blec::Result<()> {
    if foreground.has_changed().unwrap_or(false) {
        return Ok(());
    }
    let (sender, mut batches) = mpsc::channel(4);
    handler
        .discover(Some(sender), u64::MAX, ScanFilter::None, false)
        .await?;
    status(app, "Écoute Bluetooth active");
    let mut links: HashMap<String, (JoinHandle<()>, Instant)> = HashMap::new();
    let mut check_adapter_at = Instant::now() + RETRY;

    loop {
        let batch = {
            let change = foreground.changed();
            let batch = tokio::time::timeout(RETRY, batches.recv());
            pin_mut!(change, batch);
            match select(change, batch).await {
                Either::Left(_) => break,
                Either::Right((batch, _)) => batch,
            }
        };
        let devices = match batch {
            Ok(Some(devices)) => devices,
            Ok(None) => break,
            Err(_) if !handler.is_scanning().await => break,
            Err(_) => Vec::new(),
        };
        if Instant::now() >= check_adapter_at {
            if matches!(handler.get_adapter_state().await, AdapterState::Off) {
                break;
            }
            check_adapter_at = Instant::now() + RETRY;
        }
        if foreground.has_changed().unwrap_or(false) {
            break;
        }
        links.retain(|_, (task, retry_at)| !task.is_finished() || Instant::now() < *retry_at);
        for device in devices {
            if let Some(payload) = device.service_data.get(&COMPOSITION) {
                // The plugin periodically returns cached peripheral snapshots. An unchanged
                // payload is not a new advertisement or a reason to replay a completed weighing.
                if previous_payloads.get(&device.address) != Some(payload) {
                    previous_payloads.insert(device.address.clone(), payload.clone());
                    let source = device_source(&device);
                    source.metadata(app, device.manufacturer_data.keys().copied());
                    source.frame(app, "181B", payload, "Advertisement");
                }
            } else if device.services.contains(&WEIGHT)
                && links.len() < 8
                && !links.contains_key(&device.address)
            {
                let address = device.address.clone();
                let app = app.clone();
                let task = tokio::spawn(async move { listen_weight(&app, handler, device).await });
                links.insert(address, (task, Instant::now() + Duration::from_secs(15)));
            }
        }
    }

    for (task, _) in links.values() {
        task.abort();
    }
    let stopped = handler.stop_scan().await;
    for (_, (task, _)) in links {
        let _ = task.await;
    }
    let _ = handler.disconnect_all().await;
    stopped
}

fn device_source(device: &BleDevice) -> Source {
    let name = (device.name != device.address).then_some(device.name.as_str());
    Source::new(&device.address, name, device.rssi)
}

async fn listen_weight(app: &AppHandle, handler: &'static Handler, device: BleDevice) {
    let (disconnected, lost) = tokio::sync::oneshot::channel();
    let on_disconnect = OnDisconnectHandler::from_sync(move || {
        let _ = disconnected.send(());
    });
    let Ok(connection) = handler.connect(&device.address, on_disconnect, false).await else {
        return;
    };
    let source = device_source(&device);
    source.metadata(app, device.manufacturer_data.keys().copied());
    let app = app.clone();
    let subscribed = connection
        .subscribe(WEIGHT_MEASUREMENT, Some(WEIGHT), move |payload: Vec<u8>| {
            source.frame(&app, "181D", &payload, "Gatt");
        })
        .await;
    if subscribed.is_ok() {
        let _ = lost.await;
    }
    let _ = connection.disconnect().await;
}
