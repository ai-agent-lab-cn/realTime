import { app, BrowserWindow, ipcMain, clipboard, session, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { saveHistory } from './history.js'
import { NativeModels } from './local-models.js'
import { LocalRuntime } from './local-runtime.js'
import { LocalDiagnostics, saveDiagnostics } from './local-diagnostics.js'
import { validateToken } from './local-processing.js'
import type { LocalAudioRequest, LocalTranscript } from './local-types.js'
import { allowAudioPermission, allowResource } from './local-permissions.js'
const here = dirname(fileURLToPath(import.meta.url))
const diagnostics = new LocalDiagnostics()
let diagnosticToken: string | null = null
let diagnosticSaved: { runId: string; path?: string; error?: string } | undefined
let preparationGeneration = 0
let preparingToken: string | null = null
const runtime = new LocalRuntime(new NativeModels(join(here, '..')), (key, stage) =>
  diagnostics.mark(key, stage),
)
async function persistDiagnostics(token: string) {
  const report = diagnostics.finish(token)
  if (!report || !report.requests.length) return
  try {
    const path = await saveDiagnostics(report, join(app.getPath('userData'), 'diagnostics'))
    if (diagnostics.report()?.runId === report.runId)
      diagnosticSaved = { runId: report.runId, path }
  } catch {
    if (diagnostics.report()?.runId === report.runId)
      diagnosticSaved = { runId: report.runId, error: '本地延迟记录保存失败' }
  }
}
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
    validateToken(token)
    const generation = ++preparationGeneration
    preparingToken = token
    try {
      if (diagnosticToken) {
        runtime.cancel(diagnosticToken)
        await persistDiagnostics(diagnosticToken)
      }
      if (generation !== preparationGeneration || preparingToken !== token)
        throw new Error('准备已取消')
      diagnostics.prepare(
        token,
        process.env.SHIYI_DIAGNOSTIC_SOURCE === 'fixture' ? 'fixture' : 'microphone',
      )
      diagnosticToken = token
      diagnosticSaved = undefined
      try {
        await runtime.prepare(token)
      } catch (error) {
        await persistDiagnostics(token)
        throw error
      }
    } finally {
      if (generation === preparationGeneration) preparingToken = null
    }
  })
  ipcMain.handle('local:record-timing', (event, value) => {
    authorized(event)
    diagnostics.metric(value)
  })
  ipcMain.handle('local:diagnostics', (event) => {
    authorized(event)
    return {
      report: diagnostics.report(),
      savedPath: diagnosticSaved?.path,
      saveError: diagnosticSaved?.error,
    }
  })
  function callbacks(event: Electron.IpcMainInvokeEvent, request: LocalAudioRequest) {
    const key = {
      token: request.token,
      id: request.id,
      revision: request.revision,
      time: request.time,
    }
    const recognized = (en: string, caption?: LocalTranscript['caption']) => {
      if (!event.sender.isDestroyed())
        event.sender.send('local:recognized', { ...key, en, ...(caption ? { caption } : {}) })
    }
    const translated = (phase: 'progress' | 'complete') => (result: LocalTranscript) => {
      if (!event.sender.isDestroyed())
        event.sender.send('local:translated', {
          ...key,
          ...result,
          phase,
          audioFinal: request.final,
        })
    }
    return { recognized, progress: translated('progress'), complete: translated('complete') }
  }
  ipcMain.handle('local:transcribe', async (event, request) => {
    authorized(event)
    diagnostics.mark(request, 'received')
    const notify = callbacks(event, request)
    return runtime.transcribe(request, notify.recognized, notify.progress)
  })
  ipcMain.handle('local:recognize', async (event, request) => {
    authorized(event)
    diagnostics.mark(request, 'received')
    const notify = callbacks(event, request)
    return runtime.recognize(request, notify.recognized, notify.progress, notify.complete)
  })
  ipcMain.handle('local:cancel-request', (event, request) => {
    authorized(event)
    runtime.cancelRequest(request)
  })
  ipcMain.handle('local:cancel', async (event, token) => {
    authorized(event)
    if (preparingToken === token) {
      preparationGeneration++
      preparingToken = null
    }
    runtime.cancel(token)
    await persistDiagnostics(token)
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
