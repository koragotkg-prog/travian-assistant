mod commands;
mod sidecar;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Start the Node.js sidecar
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::start(&handle).await {
                    eprintln!("[Tauri] Failed to start sidecar: {}", e);
                }
            });

            // Register system tray
            tray::setup(app.handle())?;

            Ok(())
        })
        // Close button hides window; only Quit from tray actually exits
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_bot,
            commands::stop_bot,
            commands::pause_bot,
            commands::emergency_stop,
            commands::get_status,
            commands::get_servers,
            commands::save_config,
            commands::get_config,
            commands::get_logs,
            commands::clear_logs,
            commands::get_queue,
            commands::clear_queue,
            commands::get_strategy,
            commands::request_scan,
            commands::toggle_browser,
            commands::get_browser_status,
            commands::open_page,
            commands::close_page,
            commands::set_cookies,
            commands::import_chrome_cookies,
            commands::shutdown_sidecar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
