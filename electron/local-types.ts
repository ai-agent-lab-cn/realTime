export interface LocalAudioRequest {
  token: string
  id: number
  revision: number
  pcm: ArrayBuffer
  final: boolean
  time: number
  terms: boolean
}
export interface LocalTranscript {
  en: string
  zh: string
  error?: string
  pending?: boolean
  caption?: { id: number; revision: number; time: number }
}
export type LocalRecognition = Pick<LocalAudioRequest, 'token' | 'id' | 'revision' | 'time'> & {
  en: string
}
export type LocalRequestKey = Pick<LocalAudioRequest, 'token' | 'id' | 'revision'>
export interface LocalBridge {
  cancelRequest?: (request: LocalRequestKey) => Promise<void>
  onRecognized?: (listener: (result: LocalRecognition) => void) => () => void
  prepare: (token: string) => Promise<void>
  transcribe: (request: LocalAudioRequest) => Promise<LocalTranscript>
  cancel: (token: string) => Promise<void>
}
