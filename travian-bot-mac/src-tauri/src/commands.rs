//! Tauri IPC commands — thin wrappers that forward to the Node.js sidecar.
//!
//! Frontend calls: `await invoke('start_bot', { serverKey: '...' })`
//! Each command sends a JSON-RPC request to the sidecar and returns the result.

use serde_json::Value;
use tauri::AppHandle;

use crate::sidecar;

// ── Bot Lifecycle ────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_bot(
    handle: AppHandle,
    server_key: String,
    url: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "serverKey": server_key });
    if let Some(u) = url {
        params["url"] = Value::String(u);
    }
    sidecar::call(&handle, "startBot", params).await
}

#[tauri::command]
pub async fn stop_bot(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "stopBot", serde_json::json!({ "serverKey": server_key })).await
}

#[tauri::command]
pub async fn pause_bot(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "pauseBot", serde_json::json!({ "serverKey": server_key })).await
}

#[tauri::command]
pub async fn emergency_stop(
    handle: AppHandle,
    server_key: Option<String>,
    reason: Option<String>,
) -> Result<Value, String> {
    let params = serde_json::json!({
        "serverKey": server_key,
        "reason": reason
    });
    sidecar::call(&handle, "emergencyStop", params).await
}

// ── Status & Monitoring ──────────────────────────────────────────────

#[tauri::command]
pub async fn get_status(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "getStatus", serde_json::json!({ "serverKey": server_key })).await
}

#[tauri::command]
pub async fn get_servers(handle: AppHandle) -> Result<Value, String> {
    sidecar::call(&handle, "getServers", serde_json::json!({})).await
}

// ── Configuration ────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_config(
    handle: AppHandle,
    server_key: Option<String>,
    config: Value,
) -> Result<Value, String> {
    let params = serde_json::json!({
        "serverKey": server_key,
        "config": config
    });
    sidecar::call(&handle, "saveConfig", params).await
}

#[tauri::command]
pub async fn get_config(
    handle: AppHandle,
    server_key: Option<String>,
) -> Result<Value, String> {
    sidecar::call(&handle, "getConfig", serde_json::json!({ "serverKey": server_key })).await
}

// ── Logs ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_logs(
    handle: AppHandle,
    level: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let params = serde_json::json!({ "level": level, "limit": limit });
    sidecar::call(&handle, "getLogs", params).await
}

#[tauri::command]
pub async fn clear_logs(handle: AppHandle) -> Result<Value, String> {
    sidecar::call(&handle, "clearLogs", serde_json::json!({})).await
}

// ── Task Queue ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_queue(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "getQueue", serde_json::json!({ "serverKey": server_key })).await
}

#[tauri::command]
pub async fn clear_queue(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "clearQueue", serde_json::json!({ "serverKey": server_key })).await
}

// ── Strategy ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_strategy(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "getStrategy", serde_json::json!({ "serverKey": server_key })).await
}

// ── Scanning ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn request_scan(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "requestScan", serde_json::json!({ "serverKey": server_key })).await
}

// ── Browser ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn toggle_browser(handle: AppHandle, headless: Option<bool>) -> Result<Value, String> {
    sidecar::call(&handle, "toggleBrowser", serde_json::json!({ "headless": headless })).await
}

#[tauri::command]
pub async fn get_browser_status(handle: AppHandle) -> Result<Value, String> {
    sidecar::call(&handle, "getBrowserStatus", serde_json::json!({})).await
}

// ── Page Management ──────────────────────────────────────────────────

#[tauri::command]
pub async fn open_page(
    handle: AppHandle,
    server_key: String,
    url: Option<String>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "serverKey": server_key });
    if let Some(u) = url {
        params["url"] = Value::String(u);
    }
    sidecar::call(&handle, "openPage", params).await
}

#[tauri::command]
pub async fn close_page(handle: AppHandle, server_key: String) -> Result<Value, String> {
    sidecar::call(&handle, "closePage", serde_json::json!({ "serverKey": server_key })).await
}

// ── Cookies ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn set_cookies(
    handle: AppHandle,
    server_key: String,
    cookies: Value,
) -> Result<Value, String> {
    let params = serde_json::json!({
        "serverKey": server_key,
        "cookies": cookies
    });
    sidecar::call(&handle, "setCookies", params).await
}

// ── Chrome Cookie Import ──────────────────────────────────────────────

#[tauri::command]
pub async fn import_chrome_cookies(
    handle: AppHandle,
    host_like: Option<String>,
) -> Result<Value, String> {
    let params = serde_json::json!({ "hostLike": host_like });
    sidecar::call(&handle, "importChromeCookies", params).await
}

// ── Shutdown ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn shutdown_sidecar(handle: AppHandle) -> Result<Value, String> {
    sidecar::call(&handle, "shutdown", serde_json::json!({})).await
}
