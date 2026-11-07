const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

let mainWindow;

// ── IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('kraken:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the folder Kraken should work in',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── Auto-updater (loaded lazily so missing module never crashes the app) ──
function initUpdater(win) {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      win.webContents.send('updater:status', { status: 'available', version: info.version });
    });
    autoUpdater.on('download-progress', (p) => {
      win.webContents.send('updater:progress', { percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      win.webContents.send('updater:status', { status: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', () => {});

    ipcMain.handle('updater:install', () => autoUpdater.quitAndInstall(false, true));
    ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates().catch(() => {}));

    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 2 * 60 * 60 * 1000);
  } catch (e) {
    // electron-updater not available in this build — skip silently
    console.log('Auto-updater not available:', e.message);
  }
}

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
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'app.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 1500);
    initUpdater(mainWindow);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
