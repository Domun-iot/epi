mod bluetooth;
mod storage;
#[cfg(desktop)]
mod window_preferences;

use tauri::AppHandle;

#[tauri::command]
fn start_bluetooth(app: AppHandle) {
    bluetooth::start(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "android")]
    let builder =
        builder
            .plugin(tauri_plugin_blec::init())
            .on_window_event(|_, event| match event {
                tauri::WindowEvent::Suspended => bluetooth::set_foreground(false),
                tauri::WindowEvent::Resumed => bluetooth::set_foreground(true),
                _ => {}
            });
    #[cfg(desktop)]
    let builder = builder.setup(|app| {
        if let Err(error) = window_preferences::setup(app.handle()) {
            eprintln!("Préférences de la fenêtre : {error}");
        }
        Ok(())
    });
    builder
        .invoke_handler(tauri::generate_handler![
            start_bluetooth,
            storage::load_session,
            storage::save_session,
            storage::import_files,
            storage::export_files
        ])
        .run(tauri::generate_context!())
        .expect("impossible de démarrer éPI");
}
