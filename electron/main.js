const { app, BrowserWindow, shell, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const PORT = 3000
let mainWindow = null
let serverProcess = null

function waitForServer(url, retries = 30, delay = 500) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (res) => {
        if (res.statusCode < 500) resolve()
        else setTimeout(attempt, delay)
      }).on('error', () => {
        if (retries-- > 0) setTimeout(attempt, delay)
        else reject(new Error('Server did not start in time'))
      })
    }
    attempt()
  })
}

function startServer() {
  const serverPath = path.join(__dirname, '..', '.output', 'server', 'index.mjs')
  serverProcess = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
    stdio: 'pipe',
  })
  serverProcess.stdout?.on('data', (d) => console.log('[server]', d.toString()))
  serverProcess.stderr?.on('data', (d) => console.error('[server]', d.toString()))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#121212',
    show: false,
  })

  mainWindow.loadURL(`http://localhost:${PORT}`)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(async () => {
  startServer()
  try {
    await waitForServer(`http://localhost:${PORT}`)
  } catch (e) {
    console.error('Server failed to start:', e)
    dialog.showErrorBox(
      'Calvras — Server Error',
      'The local server failed to start. Please try relaunching the app.\n\n' + e.message
    )
    app.quit()
    return
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => {
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
  }
})
