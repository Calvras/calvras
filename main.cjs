const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const log = require('electron-log');

// ── Logging ──────────────────────────────────────────────────────────────
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;         // download silently in background
autoUpdater.autoInstallOnAppQuit = true; // install when user quits

let mainWindow;

// ── Auto-updater events ───────────────────────────────────────────────────
autoUpdater.on('checking-for-update', () => {
  log.info('Checking for update...');
  if (mainWindow) mainWindow.webContents.send('updater:status', { status: 'checking' });
});

autoUpdater.on('update-available', (info) => {
  log.info('Update available:', info.version);
  if (mainWindow) mainWindow.webContents.send('updater:status', {
    status: 'available',
    version: info.version,
  });
});

autoUpdater.on('update-not-available', () => {
  log.info('No update available.');
  if (mainWindow) mainWindow.webContents.send('updater:status', { status: 'up-to-date' });
});

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) mainWindow.webContents.send('updater:progress', {
    percent: Math.round(progress.percent),
    transferred: progress.transferred,
    total: progress.total,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded:', info.version);
  if (mainWindow) mainWindow.webContents.send('updater:status', {
    status: 'downloaded',
    version: info.version,
  });
});

autoUpdater.on('error', (err) => {
  log.error('Updater error:', err.message);
  if (mainWindow) mainWindow.webContents.send('updater:status', {
    status: 'error',
    message: err.message,
  });
});

// ── IPC handlers ──────────────────────────────────────────────────────────
ipcMain.handle('kraken:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the folder Kraken should work in',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// User clicked "Install update now" button in UI
ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Manual check triggered from UI
ipcMain.handle('updater:check', () => {
  autoUpdater.checkForUpdates();
});

// ── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: '#eeedeb',
    title: 'Kraken',
    center: true,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadFile('app.html');

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 1500);

    // Start checking for updates 3 seconds after launch
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        log.warn('Update check failed:', err.message);
      });
    }, 3000);

    // Then re-check every 2 hours while the app is open
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 2 * 60 * 60 * 1000);
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    log.error('Failed to load app.html:', code, desc);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // remove default menu bar
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
