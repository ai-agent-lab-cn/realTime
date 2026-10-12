import { app, BrowserWindow, ipcMain, clipboard, session, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { saveHistory } from './history.js'
import { NativeModels } from './local-models.js'
import { LocalRuntime } from './local-runtime.js'
import { allowAudioPermission, allowResource } from './local-permissions.js'
const here = dirname(fileURLToPath(import.meta.url))
const runtime = new LocalRuntime(new NativeModels(join(here, '..')))
const development = process.env.VITE_DEV_SERVER_URL === 'http://127.0.0.1:5187'
let main: BrowserWindow | null = null
function createWindow() {
  main = new BrowserWindow({
    width: 1180,
    height: 850,
    minWidth: 600,
    minHeight: 650,
    title: '实译 · Real-time Interpreter',
    backgroundColor: '#f6f7f4',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  main.setMenuBarVisibility(false)
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  main.webContents.on('will-navigate', (event) => event.preventDefault())
  main.webContents.on('render-process-gone', () => runtime.close())
  main.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) runtime.close()
  })
  const url = process.env.VITE_DEV_SERVER_URL
  if (url === 'http://127.0.0.1:5187') void main.loadURL(url)
  else void main.loadFile(join(here, '../dist/index.html'))
  main.on('closed', () => {
    runtime.close()
    main = null
  })
}
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowResource(details.url, development) })
  })
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const media = details as Electron.MediaAccessPermissionRequest
      callback(
        allowAudioPermission({
          active: runtime.active,
          trusted:
            webContents === main?.webContents &&
            details.requestingUrl === main?.webContents.getURL(),
          mainFrame: details.isMainFrame,
          permission,
          types: media.mediaTypes ?? [],
        }),
      )
    },
  )
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return allowAudioPermission({
      active: runtime.active,
      trusted:
        webContents === main?.webContents && details.requestingUrl === main?.webContents.getURL(),
      mainFrame: details.isMainFrame,
      permission,
      types: details.mediaType ? [details.mediaType] : [],
    })
  })
  function authorized(event: Electron.IpcMainInvokeEvent) {
    if (event.sender !== main?.webContents || event.senderFrame !== main?.webContents.mainFrame)
      throw new Error('Unauthorized')
  }
  ipcMain.handle('local:prepare', async (event, token) => {
    authorized(event)
    await runtime.prepare(token)
  })
  ipcMain.handle('local:transcribe', async (event, request) => {
    authorized(event)
    return runtime.transcribe(request, (en) => {
      if (!event.sender.isDestroyed())
        event.sender.send('local:recognized', {
          token: request.token,
          id: request.id,
          revision: request.revision,
          time: request.time,
          en,
        })
    })
  })
  ipcMain.handle('local:cancel-request', (event, request) => {
    authorized(event)
    runtime.cancelRequest(request)
  })
  ipcMain.handle('local:cancel', (event, token) => {
    authorized(event)
    runtime.cancel(token)
  })
  ipcMain.handle('clipboard:write', (event, text: unknown) => {
    if (event.sender !== main?.webContents || event.senderFrame !== main?.webContents.mainFrame)
      throw new Error('Unauthorized')
    if (typeof text !== 'string' || text.length > 1000000)
      throw new Error('Invalid clipboard content')
    clipboard.writeText(text)
  })
  const historyDirectory = () => join(app.getPath('desktop'), '实译历史记录')
  ipcMain.handle('history:save', async (event, request) => {
    if (event.sender !== main?.webContents || event.senderFrame !== main?.webContents.mainFrame)
      throw new Error('Unauthorized')
    return saveHistory(historyDirectory(), request)
  })
  ipcMain.handle('history:open', async (event) => {
    if (event.sender !== main?.webContents || event.senderFrame !== main?.webContents.mainFrame)
      throw new Error('Unauthorized')
    await mkdir(historyDirectory(), { recursive: true })
    const error = await shell.openPath(historyDirectory())
    if (error) throw new Error(error)
  })
  createWindow()
  app.on('activate', () => {
    if (!main) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => runtime.close())
