import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld('desktop', {
  saveHistory: (record: { id: string; startedAt: string; content: string }): Promise<string> =>
    ipcRenderer.invoke('history:save', record),
  openHistory: (): Promise<void> => ipcRenderer.invoke('history:open'),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
})
