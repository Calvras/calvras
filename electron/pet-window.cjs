'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PET_WIDTH = 230;
const PET_HEIGHT = 265;

function createPetWindow({ BrowserWindow, ipcMain, Menu, screen, getMainWindow, onEnabledChange, positionPath }) {
  let window = null;
  let activity = { working: false, text: 'Ready when you are' };
  const page = path.join(__dirname, 'pet.html');
  function status() { return { enabled: Boolean(window && !window.isDestroyed()), ...activity }; }
  function publish() { onEnabledChange(status()); }
  function clampToDisplay(x, y) {
    const area = screen.getDisplayMatching({ x, y, width: PET_WIDTH, height: PET_HEIGHT }).workArea;
    return {
      x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - PET_WIDTH)),
      y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - PET_HEIGHT)),
    };
  }
  function initialPosition(defaultArea) {
    const fallback = { x: defaultArea.x + defaultArea.width - PET_WIDTH - 16, y: defaultArea.y + defaultArea.height - PET_HEIGHT - 16 };
    if (!positionPath) return fallback;
    try {
      const saved = JSON.parse(fs.readFileSync(positionPath, 'utf8'));
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clampToDisplay(saved.x, saved.y);
    } catch { /* first run or unreadable state — use the default corner */ }
    return fallback;
  }
  function setEnabled(enabled) {
    if (!enabled) { window?.close(); return status(); }
    if (window && !window.isDestroyed()) { window.showInactive(); return status(); }
    const main = getMainWindow();
    const area = (main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()).workArea;
    const position = initialPosition(area);
    window = new BrowserWindow({ width: PET_WIDTH, height: PET_HEIGHT, x: position.x, y: position.y,
      transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'pet-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const created = window;
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.webContents.on('will-navigate', event => event.preventDefault());
    // Windows can drop the topmost style when another process holds foreground
    // rights; re-assert it whenever the pet is shown or loses focus.
    const reassertTopmost = () => { if (!created.isDestroyed()) created.setAlwaysOnTop(true); };
    created.on('show', reassertTopmost);
    created.on('blur', reassertTopmost);
    created.webContents.once('did-finish-load', () => { if (!created.isDestroyed()) { created.webContents.send('pet:state', activity); created.showInactive(); reassertTopmost(); } });
    created.once('closed', () => { if (window === created) window = null; publish(); });
    created.loadFile(page);
    publish();
    return status();
  }
  function isPetSender(event) {
    return Boolean(window && !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame
      && event.senderFrame.url === pathToFileURL(page).href);
  }
  function requirePet(event) {
    if (!isPetSender(event)) throw new Error('Only the desktop pet can use this action.');
  }
  function menu(event) {
    requirePet(event);
    Menu.buildFromTemplate([{ label: 'Off pet', click: () => setEnabled(false) }]).popup({ window });
  }
  function restore(event) {
    requirePet(event);
    const main = getMainWindow();
    if (main && !main.isDestroyed()) { if (main.isMinimized()) main.restore(); main.show(); main.focus(); }
  }
  function drag(event, dx, dy) {
    if (!isPetSender(event) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const [x, y] = window.getPosition();
    const next = clampToDisplay(x + dx, y + dy);
    window.setPosition(next.x, next.y);
  }
  function dragEnd(event) {
    if (!isPetSender(event) || !positionPath) return;
    const [x, y] = window.getPosition();
    try {
      fs.mkdirSync(path.dirname(positionPath), { recursive: true });
      fs.writeFileSync(positionPath, JSON.stringify({ x, y }));
    } catch { /* position is best-effort; the pet still works without it */ }
  }
  ipcMain.on('pet:menu', menu);
  ipcMain.on('pet:restore', restore);
  ipcMain.on('pet:drag', drag);
  ipcMain.on('pet:drag-end', dragEnd);
  return { status, setEnabled,
    setActivity(value) {
      if (!value || typeof value.working !== 'boolean' || typeof value.text !== 'string') throw new Error('Invalid pet activity.');
      activity = { working: value.working, text: value.text.slice(0, 90) };
      if (window && !window.isDestroyed()) window.webContents.send('pet:state', activity);
      return status();
    },
    dispose() {
      setEnabled(false);
      ipcMain.removeListener('pet:menu', menu);
      ipcMain.removeListener('pet:restore', restore);
      ipcMain.removeListener('pet:drag', drag);
      ipcMain.removeListener('pet:drag-end', dragEnd);
    },
  };
}
module.exports = { createPetWindow };
