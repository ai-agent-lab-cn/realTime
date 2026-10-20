import { contextBridge, ipcRenderer } from 'electron'
import type { RendererTiming } from './diagnostic-types.js'
import type {
  LocalAudioRequest,
  LocalRecognition,
  LocalRequestKey,
  LocalTranslation,
} from './local-types.js'
contextBridge.exposeInMainWorld('desktop', {
  local: {
    recordTiming: (value: RendererTiming): Promise<void> =>
      ipcRenderer.invoke('local:record-timing', value),
    diagnostics: () => ipcRenderer.invoke('local:diagnostics'),
    cancelRequest: (request: LocalRequestKey): Promise<void> =>
      ipcRenderer.invoke('local:cancel-request', request),
    onRecognized: (listener: (result: LocalRecognition) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: LocalRecognition) =>
        listener(result)
      ipcRenderer.on('local:recognized', handler)
      return () => ipcRenderer.removeListener('local:recognized', handler)
    },
    onTranslated: (listener: (result: LocalTranslation) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: LocalTranslation) =>
        listener(result)
      ipcRenderer.on('local:translated', handler)
      return () => ipcRenderer.removeListener('local:translated', handler)
    },
    prepare: (token: string): Promise<void> => ipcRenderer.invoke('local:prepare', token),
    recognize: (request: LocalAudioRequest) => ipcRenderer.invoke('local:recognize', request),
    transcribe: (request: LocalAudioRequest) => ipcRenderer.invoke('local:transcribe', request),
    cancel: (token: string): Promise<void> => ipcRenderer.invoke('local:cancel', token),
  },
  saveHistory: (record: { id: string; startedAt: string; content: string }): Promise<string> =>
    ipcRenderer.invoke('history:save', record),
  openHistory: (): Promise<void> => ipcRenderer.invoke('history:open'),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
})
