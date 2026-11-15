use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use btleplug::{
    api::{
        Central, CentralEvent, CentralState, CharPropFlags, Manager as _, Peripheral as _,
        ScanFilter,
    },
    platform::{Adapter, Manager, Peripheral, PeripheralId},
};
use futures_util::StreamExt as _;
use tauri::AppHandle;

use super::{status, Source, COMPOSITION, RETRY, WEIGHT, WEIGHT_MEASUREMENT};

type ScanError = Box<dyn std::error::Error + Send + Sync>;

pub(super) async fn run(app: &AppHandle) {
    loop {
        status(app, "epi-i18n:diagnostic.startingBluetoothListening");
        if let Err(error) = scan(app).await {
            status(app, &format!("epi-i18n:bluetoothUnavailable · {error}"));
        }
        tokio::time::sleep(RETRY).await;
    }
}

async fn scan(app: &AppHandle) -> Result<(), ScanError> {
    let manager = Manager::new().await?;
    let mut adapters = manager.adapters().await?;
    let mut adapter = None;
    for candidate in adapters.drain(..) {
        if candidate.adapter_state().await? == CentralState::PoweredOn {
            adapter = Some(candidate);
            break;
        }
    }
    let adapter = adapter.ok_or("epi-i18n:bluetoothNoAdapter")?;
    let mut events = adapter.events().await?;
    adapter.start_scan(ScanFilter::default()).await?;
    status(app, "epi-i18n:diagnostic.activeBluetoothListening");

    let mut connections = Connections::default();
    let result = loop {
        let event = match tokio::time::timeout(RETRY, events.next()).await {
            Ok(Some(event)) => event,
            Ok(None) => break Err("epi-i18n:diagnostic.bluetoothStreamWasInterrupted".into()),
            Err(_) => match adapter.adapter_state().await {
                Ok(CentralState::PoweredOff | CentralState::Unknown) => {
                    break Err("epi-i18n:diagnostic.bluetoothAdapterIsNoLongerAvailable".into());
                }
                Err(error) => break Err(error.into()),
                _ => continue,
            },
        };
        match event {
            CentralEvent::ServiceDataAdvertisement { id, service_data } => {
                if let Some((source, properties)) = source(&adapter, &id).await {
                    if service_data.contains_key(&COMPOSITION) {
                        source.metadata(app, properties.manufacturer_data.keys().copied());
                    }
                    for (service, payload) in service_data {
                        if service == COMPOSITION {
                            source.frame(app, "181B", &payload, "Advertisement");
                        } else {
                            source.service_data(app, "Service", service, &payload);
                        }
                    }
                }
            }
            CentralEvent::ManufacturerDataAdvertisement {
                id,
                manufacturer_data,
            } => {
                if let Some((source, _)) = source(&adapter, &id).await {
                    for (company, payload) in manufacturer_data {
                        source.manufacturer_data(app, company, &payload);
                    }
                }
            }
            CentralEvent::ServicesAdvertisement { id, services } => {
                if let Some((source, _)) = source(&adapter, &id).await {
                    for &service in &services {
                        source.service_data(app, "Announcement", service, &[]);
                    }
                }
                if services.contains(&WEIGHT) {
                    connections.launch(app, &adapter, id).await;
                }
            }
            CentralEvent::DeviceDiscovered(id) | CentralEvent::DeviceUpdated(id) => {
                // Windows and Apple can report the advertised service before or with device discovery.
                connections.launch(app, &adapter, id).await;
            }
            CentralEvent::StateUpdate(CentralState::PoweredOff | CentralState::Unknown) => {
                break Err("epi-i18n:diagnostic.bluetoothAdapterIsNoLongerAvailable".into());
            }
            _ => {}
        }
    };
    connections.stop().await;
    let _ = adapter.stop_scan().await;
    result
}

async fn source(
    adapter: &Adapter,
    id: &PeripheralId,
) -> Option<(Source, btleplug::api::PeripheralProperties)> {
    let peripheral = adapter.peripheral(id).await.ok()?;
    let properties = peripheral
        .properties()
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    #[cfg(target_vendor = "apple")]
    let identity = id.to_string();
    #[cfg(not(target_vendor = "apple"))]
    let identity = peripheral.address().to_string();
    let name = properties
        .advertisement_name
        .as_deref()
        .or(properties.local_name.as_deref());
    Some((Source::new(&identity, name, properties.rssi), properties))
}

#[derive(Default)]
struct Connections {
    links: HashMap<PeripheralId, (tokio::task::JoinHandle<()>, Instant)>,
}

impl Connections {
    async fn launch(&mut self, app: &AppHandle, adapter: &Adapter, id: PeripheralId) {
        self.links
            .retain(|_, (task, retry_at)| !task.is_finished() || Instant::now() < *retry_at);
        if self.links.contains_key(&id) || self.links.len() >= 8 {
            return;
        }
        let Some((source, properties)) = source(adapter, &id).await else {
            return;
        };
        if !properties.services.contains(&WEIGHT)
            || properties.service_data.contains_key(&COMPOSITION)
        {
            return;
        }
        let Ok(peripheral) = adapter.peripheral(&id).await else {
            return;
        };
        source.metadata(app, properties.manufacturer_data.keys().copied());
        let app = app.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = listen_weight(&app, &peripheral, &source).await {
                eprintln!("Bluetooth Weight Scale : {error}");
            }
            let _ = tokio::time::timeout(RETRY, peripheral.disconnect()).await;
        });
        self.links.insert(id, (task, Instant::now() + RETRY));
    }

    async fn stop(self) {
        for (_, (task, _)) in self.links {
            task.abort();
        }
    }
}

async fn listen_weight(
    app: &AppHandle,
    peripheral: &Peripheral,
    source: &Source,
) -> Result<(), ScanError> {
    tokio::time::timeout(Duration::from_secs(15), peripheral.connect()).await??;
    tokio::time::timeout(Duration::from_secs(8), peripheral.discover_services()).await??;
    let characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|characteristic| {
            characteristic.uuid == WEIGHT_MEASUREMENT
                && characteristic.service_uuid == WEIGHT
                && characteristic
                    .properties
                    .intersects(CharPropFlags::INDICATE | CharPropFlags::NOTIFY)
        })
        .ok_or("epi-i18n:diagnostic.missingWeighInCharacteristic")?;
    let mut notifications = peripheral.notifications().await?;
    tokio::time::timeout(
        Duration::from_secs(8),
        peripheral.subscribe(&characteristic),
    )
    .await??;
    loop {
        match tokio::time::timeout(RETRY, notifications.next()).await {
            Ok(Some(notification)) if notification.uuid == WEIGHT_MEASUREMENT => {
                source.frame(app, "181D", &notification.value, "Gatt");
            }
            Ok(None) => return Ok(()),
            Err(_) if !peripheral.is_connected().await? => return Ok(()),
            _ => {}
        }
    }
}
