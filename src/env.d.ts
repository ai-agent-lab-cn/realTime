/// <reference types="vite/client" />
import type { LocalBridge } from '../electron/local-types'
declare global {
  interface Window {
    desktop?: {
      copy: (text: string) => Promise<void>
      saveHistory: (record: { id: string; startedAt: string; content: string }) => Promise<string>
      openHistory: () => Promise<void>
      local?: LocalBridge
    }
  }
}
