/// <reference types="vite/client" />
interface Window {
  desktop?: {
    copy: (text: string) => Promise<void>
    saveHistory: (record: { id: string; startedAt: string; content: string }) => Promise<string>
    openHistory: () => Promise<void>
  }
}
