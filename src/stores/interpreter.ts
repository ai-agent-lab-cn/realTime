import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { createSession, command, accept, discard, copyText } from '../domain/session'
import type { LocalTranscript } from '../../electron/local-types'
import { script, terminology } from '../demo/script'
export const useInterpreter = defineStore('interpreter', () => {
  const session = reactive(createSession())
  const elapsed = ref(0)
  const source = ref<'demo' | 'local'>(
    typeof window !== 'undefined' && window.desktop?.local ? 'local' : 'demo',
  )
  const recordId = ref(''),
    startedAt = ref('')
  const settings = reactive({
    mode: 'bilingual' as 'bilingual' | 'chinese',
    size: 'standard' as 'small' | 'standard' | 'large',
    autoScroll: true,
    terms: true,
  })
  let timer: ReturnType<typeof setInterval> | undefined
  let cursor = 0,
    phase = 0,
    id = 0
  const finalCount = computed(() => session.captions.filter((c) => c.final).length)
  function cancel() {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
  function play() {
    cancel()
    const epoch = session.epoch
    timer = setInterval(() => {
      if (session.status !== 'Listening' || epoch !== session.epoch) {
        cancel()
        return
      }
      elapsed.value += 0.5
      phase++
      const line = script[cursor]
      if (!line) {
        stop()
        return
      }
      if ([1, 3, 5, 8].includes(phase)) {
        const final = phase === 8,
          ratio = final ? 1 : phase === 1 ? 0.32 : phase === 3 ? 0.6 : 0.85
        const words = line.en.split(' '),
          translated = terminology(line.zh, settings.terms)
        accept(session, {
          epoch,
          id,
          revision: phase,
          en: final
            ? line.en
            : words.slice(0, Math.max(1, Math.ceil(words.length * ratio))).join(' ') + '…',
          zh: final ? translated : translated.slice(0, Math.ceil(translated.length * ratio)) + '…',
          final,
          time: Math.max(0, elapsed.value - phase * 0.5),
        })
      }
      if (phase === 10) {
        cursor++
        id++
        phase = 0
        if (cursor >= script.length) stop()
      }
    }, 500)
  }
  function localClock() {
    cancel()
    const epoch = session.epoch
    timer = setInterval(() => {
      if (session.status !== 'Listening' || epoch !== session.epoch) cancel()
      else elapsed.value += 0.5
    }, 500)
  }
  function start() {
    if (session.status !== 'Ready' && session.status !== 'Stopped') return
    cancel()
    recordId.value = crypto.randomUUID()
    startedAt.value = new Date().toISOString()
    command(session, 'start')
    cursor = 0
    phase = 0
    id = 0
    elapsed.value = 0
    if (source.value === 'demo') play()
    else localClock()
  }
  function pause() {
    if (session.status !== 'Listening') return
    cancel()
    command(session, 'pause')
  }
  function resume() {
    if (session.status !== 'Paused') return
    if (source.value === 'demo' && phase > 0) {
      cursor++
      id++
      phase = 0
    }
    command(session, 'resume')
    if (source.value === 'demo') {
      if (cursor >= script.length) stop()
      else play()
    } else localClock()
  }
  function stop() {
    cancel()
    command(session, 'stop')
  }
  function clear() {
    cancel()
    command(session, 'clear')
    if (source.value === 'demo' && phase > 0) {
      cursor++
      id++
      phase = 0
    }
    if (session.status === 'Listening') {
      if (source.value === 'demo') play()
      else localClock()
    }
  }
  function acceptLocal(
    segment: { id: number; revision: number; final: boolean; time: number },
    result: LocalTranscript,
    epoch: number,
  ) {
    if (source.value !== 'local') return
    if (result.caption)
      segment = { ...segment, ...result.caption, revision: result.caption.revision * 2 + 1 }
    if (!result.en.trim() && !result.zh.trim() && !result.error) {
      if (segment.final) discard(session, epoch, segment.id)
      return
    }
    const previous = session.captions.find((c) => c.id === segment.id)
    accept(session, {
      ...segment,
      epoch,
      en: result.error && !result.en ? (previous?.en ?? '') : result.en,
      zh: result.error && !result.en ? (previous?.zh ?? '') : result.zh,
      error: result.error,
      final:
        segment.final &&
        !result.pending &&
        !!result.en.trim() &&
        !!result.zh.trim() &&
        !result.error,
    })
  }
  function text(id?: number) {
    return copyText(session, settings.mode, id)
  }
  return {
    recordId,
    startedAt,
    session,
    elapsed,
    source,
    settings,
    finalCount,
    start,
    pause,
    resume,
    stop,
    clear,
    acceptLocal,
    text,
  }
})
