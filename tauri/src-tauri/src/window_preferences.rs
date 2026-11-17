use crate::storage;
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};
use tokio::sync::mpsc;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    position: Option<PhysicalPosition<i32>>,
    size: Option<PhysicalSize<u32>>,
    maximized: bool,
    minimized: bool,
}

impl Preferences {
    fn restore(&self, window: &WebviewWindow) -> tauri::Result<()> {
        if let Some(size) = self.size.filter(|size| size.width > 0 && size.height > 0) {
            window.set_size(size)?;
        }
        if let Some(position) = self.position {
            let visible = window.available_monitors()?.iter().any(|monitor| {
                let origin = monitor.position();
                let size = monitor.size();
                let dx = i64::from(position.x) - i64::from(origin.x);
                let dy = i64::from(position.y) - i64::from(origin.y);
                let width = i64::from(self.size.map_or(0, |size| size.width));
                let visible_width = (dx + width).min(i64::from(size.width)) - dx.max(0);
                visible_width >= 64 && (0..i64::from(size.height)).contains(&dy)
            });
            if visible {
                window.set_position(position)?;
            }
        }
        if self.maximized {
            window.maximize()?;
        }
        Ok(())
    }

    fn capture(&mut self, window: &WebviewWindow) -> tauri::Result<()> {
        self.minimized = window.is_minimized()?;
        if !self.minimized {
            self.maximized = window.is_maximized()?;
        }
        if !self.minimized && !self.maximized {
            let size = window.inner_size()?;
            if size.width > 0 && size.height > 0 {
                self.size = Some(size);
                self.position = window.outer_position().ok();
            }
        }
        Ok(())
    }
}

pub(crate) fn setup(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Fenêtre introuvable.")?;
    let saved = storage::installation_root(app).and_then(|root| {
        let saved = crate::account_storage::read_window(&root)?;
        let preferences: Preferences = serde_json::from_value(saved).unwrap_or_default();
        if let Err(error) = preferences.restore(&window) {
            eprintln!("Restauration de la fenêtre : {error}");
        }
        Ok((root, preferences))
    });
    // Show the window even if the preferences could not be read.
    window.show().map_err(|error| error.to_string())?;
    let (root, preferences) = saved?;
    if preferences.minimized {
        window.minimize().map_err(|error| error.to_string())?;
    }

    let mut current = preferences;
    current
        .capture(&window)
        .map_err(|error| error.to_string())?;
    let current = Mutex::new(current);
    let persist = Arc::new(move |window: &WebviewWindow| {
        let Ok(mut current) = current.lock() else {
            return;
        };
        // Keep the normal bounds when maximizing or minimizing the window.
        let mut next = *current;
        if next.capture(window).is_err() || next == *current {
            return;
        }
        let result = serde_json::to_value(next)
            .map_err(|error| error.to_string())
            .and_then(|value| crate::account_storage::save_window(&root, value));
        match result {
            Ok(()) => *current = next,
            Err(error) => eprintln!("Enregistrement de la fenêtre : {error}"),
        }
    });

    let (changes, mut pending) = mpsc::channel(1);
    let window_handle = window.clone();
    let save = Arc::clone(&persist);
    tauri::async_runtime::spawn(async move {
        while pending.recv().await.is_some() {
            // The move event can precede the window manager's state change.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let _ = pending.try_recv();
            let window = window_handle.clone();
            let save = Arc::clone(&save);
            let _ = window_handle.run_on_main_thread(move || save(&window));
        }
    });
    let window_handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
            let _ = changes.try_send(());
        }
        WindowEvent::CloseRequested { .. } => persist(&window_handle),
        _ => {}
    });
    Ok(())
}
