//! Sidecar Manager — spawns and communicates with the Node.js sidecar process.
//!
//! Protocol: JSON-RPC over stdin/stdout (one JSON object per line).
//!
//! Outgoing → sidecar:  { "id": N, "method": "...", "params": {...} }
//! Incoming ← sidecar:  { "id": N, "result": ... }  or  { "id": N, "error": {...} }
//! Events   ← sidecar:  { "event": "...", "data": {...} }

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, oneshot};

/// Global sidecar state, stored as Tauri managed state.
pub struct SidecarState {
    stdin: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
    child: Arc<Mutex<Option<Child>>>,
}

impl SidecarState {
    fn new() -> Self {
        Self {
            stdin: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            child: Arc::new(Mutex::new(None)),
        }
    }
}

/// Resolve the path to the sidecar directory.
fn sidecar_dir(handle: &AppHandle) -> PathBuf {
    // In development: sidecar lives next to src-tauri
    // In production: sidecar is bundled in the app resources
    let resource_dir = handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .join("sidecar");

    if dev_path.join("index.js").exists() {
        dev_path
    } else {
        resource_dir.join("sidecar")
    }
}

/// Start the Node.js sidecar process.
pub async fn start(handle: &AppHandle) -> Result<(), String> {
    let state = SidecarState::new();
    let sidecar_path = sidecar_dir(handle);
    let index_js = sidecar_path.join("index.js");

    if !index_js.exists() {
        return Err(format!("Sidecar not found at {:?}", index_js));
    }

    eprintln!("[Tauri] Starting sidecar from {:?}", sidecar_path);

    let mut child = Command::new("node")
        .arg("index.js")
        .current_dir(&sidecar_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    *state.stdin.lock().await = Some(stdin);
    *state.child.lock().await = Some(child);

    let pending = state.pending.clone();
    let app_handle = handle.clone();

    // Spawn stdout reader — parses JSON-RPC responses and events
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let parsed: Result<Value, _> = serde_json::from_str(&line);
            match parsed {
                Ok(msg) => {
                    // Check if this is an event (no "id" field)
                    if let Some(event_name) = msg.get("event").and_then(|v| v.as_str()) {
                        let data = msg.get("data").cloned().unwrap_or(Value::Null);
                        let event_key = format!("sidecar:{}", event_name);
                        let _ = app_handle.emit(&event_key, data);
                    }
                    // Check if this is an RPC response (has "id" field)
                    else if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                        let mut map = pending.lock().await;
                        if let Some(tx) = map.remove(&id) {
                            if let Some(err) = msg.get("error") {
                                let err_msg = err
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Unknown sidecar error")
                                    .to_string();
                                let _ = tx.send(Err(err_msg));
                            } else {
                                let result = msg.get("result").cloned().unwrap_or(Value::Null);
                                let _ = tx.send(Ok(result));
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[Sidecar stdout] Parse error: {} — line: {}", e, line);
                }
            }
        }
        eprintln!("[Tauri] Sidecar stdout stream ended");
    });

    // Spawn stderr reader — forward sidecar errors to Tauri console
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[Sidecar stderr] {}", line);
        }
    });

    // Store state for commands to use
    handle.manage(state);

    eprintln!("[Tauri] Sidecar started successfully");
    Ok(())
}

/// Send a JSON-RPC request to the sidecar and wait for the response.
pub async fn call(
    handle: &AppHandle,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let state = handle
        .try_state::<SidecarState>()
        .ok_or("Sidecar not started")?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);

    let request = serde_json::json!({
        "id": id,
        "method": method,
        "params": params
    });

    let line = format!("{}\n", serde_json::to_string(&request).map_err(|e| e.to_string())?);

    // Register a oneshot channel for the response
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state.pending.lock().await;
        pending.insert(id, tx);
    }

    // Write to stdin
    {
        let mut stdin_guard = state.stdin.lock().await;
        if let Some(ref mut stdin) = *stdin_guard {
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to sidecar: {}", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush sidecar stdin: {}", e))?;
        } else {
            return Err("Sidecar stdin not available".to_string());
        }
    }

    // Wait for response with timeout
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Sidecar response channel closed".to_string()),
        Err(_) => {
            // Clean up the pending entry on timeout
            let mut pending = state.pending.lock().await;
            pending.remove(&id);
            Err("Sidecar call timed out (30s)".to_string())
        }
    }
}
