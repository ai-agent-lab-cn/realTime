import { contextBridge, ipcRenderer } from 'electron'
import type { LocalAudioRequest, LocalRecognition, LocalRequestKey } from './local-types.js'
contextBridge.exposeInMainWorld('desktop', {
  local: {
    cancelRequest: (request: LocalRequestKey): Promise<void> =>
      ipcRenderer.invoke('local:cancel-request', request),
    onRecognized: (listener: (result: LocalRecognition) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: LocalRecognition) =>
        listener(result)
      ipcRenderer.on('local:recognized', handler)
      return () => ipcRenderer.removeListener('local:recognized', handler)
    },
    prepare: (token: string): Promise<void> => ipcRenderer.invoke('local:prepare', token),
    transcribe: (request: LocalAudioRequest) => ipcRenderer.invoke('local:transcribe', request),
    cancel: (token: string): Promise<void> => ipcRenderer.invoke('local:cancel', token),
  },
  saveHistory: (record: { id: string; startedAt: string; content: string }): Promise<string> =>
    ipcRenderer.invoke('history:save', record),
  openHistory: (): Promise<void> => ipcRenderer.invoke('history:open'),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
})
