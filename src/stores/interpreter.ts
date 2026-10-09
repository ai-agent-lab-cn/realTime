import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { createSession, command, accept, copyText } from '../domain/session'
import { script, terminology } from '../demo/script'
export const useInterpreter = defineStore('interpreter', () => {
  const session = reactive(createSession())
  const elapsed = ref(0)
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
    play()
  }
  function pause() {
    if (session.status !== 'Listening') return
    cancel()
    command(session, 'pause')
  }
  function resume() {
    if (session.status !== 'Paused') return
    if (phase > 0) {
      cursor++
      id++
      phase = 0
    }
    command(session, 'resume')
    if (cursor >= script.length) stop()
    else play()
  }
  function stop() {
    cancel()
    command(session, 'stop')
  }
  function clear() {
    cancel()
    command(session, 'clear')
    if (phase > 0) {
      cursor++
      id++
      phase = 0
    }
    if (session.status === 'Listening') play()
  }
  function text(id?: number) {
    return copyText(session, settings.mode, id)
  }
  return {
    recordId,
    startedAt,
    session,
    elapsed,
    settings,
    finalCount,
    start,
    pause,
    resume,
    stop,
    clear,
    text,
  }
})
