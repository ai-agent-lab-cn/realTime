export type Status = 'Ready' | 'Listening' | 'Paused' | 'Stopped'
export interface Caption {
  id: number
  revision: number
  en: string
  zh: string
  final: boolean
  time: number
}
export interface Event extends Caption {
  epoch: number
}
export interface Session {
  status: Status
  epoch: number
  captions: Caption[]
}
export function createSession(): Session {
  return { status: 'Ready', epoch: 0, captions: [] }
}
export function command(s: Session, action: 'start' | 'pause' | 'resume' | 'stop' | 'clear'): void {
  if (action === 'start' && (s.status === 'Ready' || s.status === 'Stopped')) {
    s.epoch++
    s.captions = []
    s.status = 'Listening'
  } else if (action === 'pause' && s.status === 'Listening') {
    s.epoch++
    s.status = 'Paused'
  } else if (action === 'resume' && s.status === 'Paused') {
    s.epoch++
    s.status = 'Listening'
  } else if (action === 'stop' && (s.status === 'Listening' || s.status === 'Paused')) {
    s.epoch++
    s.status = 'Stopped'
  } else if (action === 'clear') {
    s.epoch++
    s.captions = []
  }
}
export function accept(s: Session, event: Event): void {
  if (s.status !== 'Listening' || event.epoch !== s.epoch) return
  const existing = s.captions.find((c) => c.id === event.id)
  if (existing && (existing.final || event.revision <= existing.revision)) return
  const { epoch, ...caption } = event
  if (existing) Object.assign(existing, caption)
  else s.captions.push(caption)
}
export function copyText(s: Session, mode: 'bilingual' | 'chinese', id?: number): string {
  return s.captions
    .filter((c) => c.final && (id === undefined || c.id === id))
    .map((c) => (mode === 'chinese' ? c.zh : `${c.en}\n${c.zh}`))
    .join('\n\n')
}
