import type { LocalTranscript } from '../../electron/local-types'
import { sentenceUnits } from '../../electron/sentence-boundaries'
import { accept, discard, type Caption, type Session } from './session'

export interface LocalSegment {
  id: number
  revision: number
  final: boolean
  time: number
}
interface Revisions {
  source: number
  checked: number
  translated: number
  completed: number
  finished: Set<number>
  audioFinal: boolean
  completeSuccess: boolean
  completeError?: string
  units?: { revision: number; values: { source: string; zh: string }[] }
}

const normalizedSource = (text: string) => text.replace(/\s+/g, ' ').trim()

function completedPrefix(result: LocalTranscript, currentSource: string) {
  if (!result.units?.length) return
  const source = sentenceUnits(result.en)
  const current = sentenceUnits(currentSource)
  const values = result.units
  if (
    values.some(
      (unit, index) =>
        !unit.zh.trim() ||
        !source[index]?.closed ||
        !current[index]?.closed ||
        normalizedSource(unit.source) !== normalizedSource(source[index].text) ||
        normalizedSource(unit.source) !== normalizedSource(current[index].text),
    )
  )
    return
  const zh = values.map((unit) => unit.zh).join('\n')
  if (result.zh !== zh && !result.zh.startsWith(`${zh}\n`)) return
  return { values, zh }
}

/** Source and translation revisions are independent; Session keeps its immutable Final rule. */
export class LocalCaptionUpdates {
  private epoch = -1
  private revisions = new Map<number, Revisions>()

  constructor(private readonly session: Session) {}

  private current(epoch: number): boolean {
    if (this.session.status !== 'Listening' || this.session.epoch !== epoch) return false
    if (this.epoch !== epoch) {
      this.epoch = epoch
      this.revisions.clear()
    }
    return true
  }

  private route(segment: LocalSegment, result: LocalTranscript) {
    return result.caption ? { ...segment, ...result.caption } : segment
  }

  private state(id: number): Revisions {
    let value = this.revisions.get(id)
    if (!value) {
      value = {
        source: -1,
        checked: -1,
        translated: -1,
        completed: -1,
        finished: new Set(),
        audioFinal: false,
        completeSuccess: false,
      }
      this.revisions.set(id, value)
    }
    return value
  }

  private publish(segment: LocalSegment, epoch: number, update: Partial<Caption>): void {
    const previous = this.session.captions.find((caption) => caption.id === segment.id)
    accept(this.session, {
      id: segment.id,
      en: previous?.en ?? '',
      zh: previous?.zh ?? '',
      final: false,
      ...previous,
      time: segment.time,
      ...update,
      // Domain revisions order accepted display updates, not ASR/MT requests.
      revision: (previous?.revision ?? -1) + 1,
      epoch,
    })
  }

  recognize(segment: LocalSegment, result: LocalTranscript, epoch: number, checked = false): void {
    if (!this.current(epoch)) return
    const routed = this.route(segment, result)
    const previous = this.session.captions.find((caption) => caption.id === routed.id)
    if (previous?.final) return
    const state = this.state(routed.id)
    if (routed.revision < state.source) return
    // A late provisional notification cannot undo its checked acknowledgement.
    if (!checked && routed.revision === state.checked) return
    if (routed.id !== segment.id) {
      const provisional = this.session.captions.find((caption) => caption.id === segment.id)
      if (provisional && !provisional.zh && !provisional.final)
        discard(this.session, epoch, segment.id)
    }
    if (checked && !result.en.trim() && !result.error && !result.zh.trim()) {
      if (routed.revision >= state.source && !previous?.zh) discard(this.session, epoch, routed.id)
      state.source = routed.revision
      state.checked = routed.revision
      return
    }
    if (routed.revision > state.source) {
      state.source = routed.revision
    }
    if (checked) {
      state.checked = routed.revision
      state.audioFinal = segment.final
    }
    this.publish(routed, epoch, {
      en: result.en.trim() ? result.en : (previous?.en ?? ''),
      error:
        result.error ?? (state.completed === routed.revision ? state.completeError : undefined),
      final:
        checked &&
        state.completed === state.source &&
        state.completeSuccess &&
        state.audioFinal &&
        !result.error,
    })
  }

  translate(
    segment: LocalSegment,
    result: LocalTranscript,
    epoch: number,
    complete: boolean,
  ): void {
    if (!this.current(epoch)) return
    const routed = this.route(segment, result)
    let previous = this.session.captions.find((caption) => caption.id === routed.id)
    if (previous?.final) return
    const state = this.state(routed.id)
    if (routed.revision < state.translated || state.finished.has(routed.revision)) return
    // Older MT remains useful only while its source is still an intact prefix.
    // A newer correction to words/numbers/negation invalidates that translation.
    if (routed.revision < state.source) {
      const source = result.en.replace(/\s+/g, ' ').trim()
      const current = (previous?.en ?? '').replace(/\s+/g, ' ').trim()
      const numericExtension = /\d$/.test(source) && /^[.,]\d/.test(current.slice(source.length))
      if (
        numericExtension ||
        !source ||
        !current.startsWith(source) ||
        (current.length > source.length && !/[\s.!?。！？,;:]/.test(current[source.length]))
      )
        return
    }
    // A validated translation can arrive before its IPC acknowledgement.
    if (routed.revision > state.source) {
      this.recognize(segment, result, epoch, true)
      previous = this.session.captions.find((caption) => caption.id === routed.id)
    }
    const update: Partial<Caption> = {}
    if (result.zh.trim()) {
      const old = previous?.zh ?? ''
      const extendsOld = result.zh.toLocaleLowerCase().startsWith(old.toLocaleLowerCase())
      const prefix = completedPrefix(result, previous?.en ?? '')
      let replacePrefix = false
      if (
        prefix &&
        (state.units?.revision !== routed.revision ||
          prefix.values.length >= state.units.values.length)
      ) {
        const prior = state.units?.values
        const changed = prefix.values.some(
          (unit, index) => unit.source !== prior?.[index]?.source || unit.zh !== prior?.[index]?.zh,
        )
        // Cache-only/repeated prefixes must not erase the retained active tail.
        const retainsPrefix = old === prefix.zh || old.startsWith(`${prefix.zh}\n`)
        replacePrefix = changed && !retainsPrefix
        state.units = {
          revision: routed.revision,
          values: prefix.values.map((unit) => ({ ...unit })),
        }
      }
      if (!complete && replacePrefix) {
        update.zh = prefix!.zh
        state.translated = routed.revision
      } else if (complete || !old || extendsOld) {
        update.zh = result.zh
        state.translated = routed.revision
      }
    }
    if (complete) {
      state.finished.add(routed.revision)
      if (routed.revision > state.completed) {
        state.completed = routed.revision
        state.completeError = result.error
        state.completeSuccess = !result.error && !result.pending && !!result.zh.trim()
      }
      if (routed.revision === state.source) update.error = result.error
    }
    update.final =
      complete &&
      routed.revision === state.source &&
      state.checked === state.source &&
      state.audioFinal &&
      !result.pending &&
      !result.error &&
      !!previous?.en.trim() &&
      !!result.zh.trim()
    this.publish(routed, epoch, update)
  }
}
