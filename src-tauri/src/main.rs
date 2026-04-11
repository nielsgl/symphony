#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

struct BackendState(Mutex<Option<Child>>);

fn parse_desktop_port() -> u16 {
  std::env::var("SYMPHONY_DESKTOP_PORT")
    .or_else(|_| std::env::var("SYMPHONY_PORT"))
    .ok()
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(3000)
}

fn resolve_repo_root() -> PathBuf {
  if let Ok(value) = std::env::var("SYMPHONY_REPO_ROOT") {
    let path = PathBuf::from(value);
    if path.exists() {
      return path;
    }
  }

  if let Ok(path) = std::env::current_dir() {
    if path.join("scripts/start-dashboard.js").exists() {
      return path;
    }
  }

  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("..")
    .canonicalize()
    .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
}

fn spawn_backend_process(repo_root: &PathBuf, port: u16) -> Result<Child, String> {
  let launcher = repo_root.join("scripts").join("start-dashboard.js");
  if !launcher.exists() {
    return Err(format!(
      "backend launcher not found at {} (desktop host currently requires a local Symphony repo checkout and Node runtime)",
      launcher.display()
    ));
  }

  let mut command = Command::new("node");
  command
    .arg(launcher)
    .arg(format!("--port={}", port))
    .stdin(Stdio::null())
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .current_dir(repo_root);

  if let Ok(workflow_path) = std::env::var("SYMPHONY_WORKFLOW_PATH") {
    command.arg(format!("--workflow={}", workflow_path));
  }

  command
    .spawn()
    .map_err(|error| format!("failed to spawn dashboard backend: {}", error))
}

fn wait_for_backend_ready(port: u16, timeout: Duration) -> Result<(), String> {
  let address = SocketAddr::from(([127, 0, 0, 1], port));
  let deadline = Instant::now() + timeout;

  while Instant::now() < deadline {
    if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok() {
      return Ok(());
    }
    std::thread::sleep(Duration::from_millis(300));
  }

  Err(format!(
    "timed out waiting for dashboard runtime at http://127.0.0.1:{}/",
    port
  ))
}

fn stop_backend(app_handle: &tauri::AppHandle) {
  if let Some(state) = app_handle.try_state::<BackendState>() {
    if let Ok(mut guard) = state.0.lock() {
      if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
      }
    }
  }
}

fn escape_js_single_quoted(value: &str) -> String {
  value
    .replace('\\', "\\\\")
    .replace('\'', "\\'")
    .replace('\n', "\\n")
    .replace('\r', "")
}

fn show_boot_error(app: &tauri::App, message: &str) {
  if let Some(window) = app.get_webview_window("main") {
    let escaped = escape_js_single_quoted(message);
    let script = format!(
      "window.__SYMPHONY_BOOT_ERROR__='{}';if(window.renderBootError){{window.renderBootError();}}",
      escaped
    );
    let _ = window.eval(&script);
    let _ = window.show();
  }
}

fn open_runtime_window(app: &tauri::App, port: u16) {
  if let Some(window) = app.get_webview_window("main") {
    let runtime_url = format!("http://127.0.0.1:{}/", port);
    let script = format!("window.location.replace('{}');", runtime_url);
    let _ = window.eval(&script);
    let _ = window.show();
  }
}

fn main() {
  let app = tauri::Builder::default()
    .setup(|app| {
      app.manage(BackendState(Mutex::new(None)));

      let port = parse_desktop_port();
      let repo_root = resolve_repo_root();
      let mut child = match spawn_backend_process(&repo_root, port) {
        Ok(process) => process,
        Err(error) => {
          show_boot_error(app, &format!(
            "Failed to start local runtime: {}. Set SYMPHONY_OFFLINE=1 for local mode or provide LINEAR_API_KEY.",
            error
          ));
          return Ok(());
        }
      };

      if let Err(error) = wait_for_backend_ready(port, Duration::from_secs(45)) {
        let _ = child.kill();
        let _ = child.wait();
        show_boot_error(app, &format!(
          "Local runtime did not become ready: {}. Verify WORKFLOW.md path, LINEAR_API_KEY, or set SYMPHONY_OFFLINE=1.",
          error
        ));
        return Ok(());
      }

      let state = app.state::<BackendState>();
      if let Ok(mut guard) = state.0.lock() {
        *guard = Some(child);
      }

      open_runtime_window(app, port);

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building Symphony Tauri host");

  app.run(|app_handle, event| {
    if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
      stop_backend(app_handle);
    }
  });
}
