const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createBackendLaunchConfig, parseDashboardUrl } = require('../dist/src/runtime');

const STARTUP_TIMEOUT_MS = 45_000;

function createWindow() {
  return new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'Symphony Desktop',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
}

async function waitForDashboardUrl(backendProcess) {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (fn) => (value) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      backendProcess.stdout.off('data', onStdout);
      backendProcess.stderr.off('data', onStderr);
      fn(value);
    };

    const resolveOnce = finish(resolve);
    const rejectOnce = finish(reject);

    const timer = setTimeout(() => {
      rejectOnce(new Error('Timed out waiting for dashboard backend startup'));
    }, STARTUP_TIMEOUT_MS);

    const onStdout = (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const url = parseDashboardUrl(line.trim());
        if (url) {
          resolveOnce(url);
          return;
        }
      }
    };

    const onStderr = (chunk) => {
      const text = chunk.toString('utf8');
      if (/Failed to start dashboard/i.test(text)) {
        rejectOnce(new Error(text.trim()));
      }
    };

    backendProcess.stdout.on('data', onStdout);
    backendProcess.stderr.on('data', onStderr);

    backendProcess.once('exit', (code) => {
      rejectOnce(new Error(`Dashboard backend exited before startup (code ${code ?? 'unknown'})`));
    });
  });
}

function startBackend() {
  const repoRoot = path.resolve(__dirname, '..');
  const launchConfig = createBackendLaunchConfig({
    repoRoot,
    workflowPath: process.env.SYMPHONY_WORKFLOW_PATH,
    nodeBinary: process.execPath,
    offlineMode: process.env.SYMPHONY_OFFLINE === '1' || process.env.SYMPHONY_OFFLINE === 'true'
  });

  return spawn(launchConfig.nodeBinary, launchConfig.args, {
    cwd: launchConfig.cwd,
    env: {
      ...process.env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

let backendProcess = null;

async function boot() {
  const window = createWindow();
  backendProcess = startBackend();

  try {
    const url = await waitForDashboardUrl(backendProcess);
    await window.loadURL(url);
  } catch (error) {
    if (backendProcess) {
      backendProcess.kill('SIGTERM');
      backendProcess = null;
    }

    await dialog.showErrorBox('Symphony startup failed', error instanceof Error ? error.message : String(error));
    app.quit();
  }

  window.on('closed', () => {
    if (backendProcess) {
      backendProcess.kill('SIGTERM');
      backendProcess = null;
    }
  });
}

app.whenReady().then(() => {
  void boot();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void boot();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
});
