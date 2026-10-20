export interface LocalAudioRequest {
  token: string
  id: number
  revision: number
  pcm: ArrayBuffer
  final: boolean
  time: number
  terms: boolean
}
export interface CompletedTranslationUnit {
  source: string
  zh: string
}
export interface LocalTranscript {
  units?: CompletedTranslationUnit[]
  en: string
  zh: string
  error?: string
  pending?: boolean
  translationQueued?: boolean
  caption?: { id: number; revision: number; time: number }
}
export type LocalRecognition = Pick<LocalAudioRequest, 'token' | 'id' | 'revision' | 'time'> & {
  en: string
  caption?: LocalTranscript['caption']
}
export type LocalTranslation = Pick<LocalAudioRequest, 'token' | 'id' | 'revision' | 'time'> &
  LocalTranscript & { phase?: 'progress' | 'complete'; audioFinal?: boolean }
export type LocalRequestKey = Pick<LocalAudioRequest, 'token' | 'id' | 'revision'>
export interface LocalBridge {
  recordTiming?: (value: import('./diagnostic-types.js').RendererTiming) => Promise<void>
  diagnostics?: () => Promise<{
    report: import('./diagnostic-types.js').DiagnosticReport | null
    savedPath?: string
    saveError?: string
  }>
  recognize?: (request: LocalAudioRequest) => Promise<LocalTranscript>
  cancelRequest?: (request: LocalRequestKey) => Promise<void>
  onTranslated?: (listener: (result: LocalTranslation) => void) => () => void
  onRecognized?: (listener: (result: LocalRecognition) => void) => () => void
  prepare: (token: string) => Promise<void>
  transcribe: (request: LocalAudioRequest) => Promise<LocalTranscript>
  cancel: (token: string) => Promise<void>
}
