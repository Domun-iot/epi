use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use tauri::AppHandle;
use tauri_plugin_blec::{
    check_permissions, get_handler,
    models::{AdapterState, BleDevice, ScanFilter},
    Handler, OnDisconnectHandler,
};
use tokio::{sync::mpsc, task::JoinHandle};

use super::{status, Source, COMPOSITION, RETRY, WEIGHT, WEIGHT_MEASUREMENT};

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
    let mut prompt = true;
    loop {
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
        tokio::time::sleep(RETRY).await;
    }

    loop {
        if matches!(handler.get_adapter_state().await, AdapterState::Off) {
            status(
                app,
                "Bluetooth désactivé · active-le dans les paramètres Android",
            );
        } else if let Err(error) = scan(app, handler).await {
            status(app, &format!("Bluetooth indisponible · {error}"));
        }
        tokio::time::sleep(RETRY).await;
    }
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

async fn scan(app: &AppHandle, handler: &'static Handler) -> tauri_plugin_blec::Result<()> {
    let (sender, mut batches) = mpsc::channel(4);
    handler
        .discover(Some(sender), u64::MAX, ScanFilter::None, false)
        .await?;
    status(app, "Écoute Bluetooth active");
    let mut previous_payloads = HashMap::new();
    let mut links: HashMap<String, (JoinHandle<()>, Instant)> = HashMap::new();
    let mut check_adapter_at = Instant::now() + RETRY;

    loop {
        let devices = match tokio::time::timeout(RETRY, batches.recv()).await {
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

    for (_, (task, _)) in links {
        task.abort();
    }
    let _ = handler.disconnect_all().await;
    handler.stop_scan().await
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
