import { app, BrowserWindow, ipcMain, clipboard, session, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { saveHistory } from './history.js'
const here = dirname(fileURLToPath(import.meta.url))
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
    },
  })
  main.setMenuBarVisibility(false)
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  main.webContents.on('will-navigate', (event) => event.preventDefault())
  const url = process.env.VITE_DEV_SERVER_URL
  if (url === 'http://127.0.0.1:5187') void main.loadURL(url)
  else void main.loadFile(join(here, '../dist/index.html'))
  main.on('closed', () => {
    main = null
  })
}
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  )
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
