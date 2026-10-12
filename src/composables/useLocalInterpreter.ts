import { ref } from 'vue'
import { useInterpreter } from '../stores/interpreter'
import { MicrophoneCapture } from '../audio/microphone'
import { StreamingResampler } from '../audio/resample'
import { SpeechSegmenter } from '../audio/segmenter'
import { TranscriptQueue } from '../audio/transcriptQueue'

function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError')
    return '麦克风权限被拒绝，请在系统设置中允许后重试'
  if (error instanceof DOMException && error.name === 'NotFoundError')
    return '未找到可用麦克风，请检查设备后重试'
  return error instanceof Error && error.message ? error.message : '本地翻译暂不可用，请重试'
}

export function useLocalInterpreter(store: ReturnType<typeof useInterpreter>) {
  const busy = ref(false)
  const error = ref('')
  let generation = 0
  let token: string | null = null
  let capture: MicrophoneCapture | null = null
  let queue: TranscriptQueue | null = null
  let nextId = 0
  let unsubscribe: (() => void) | undefined

  function release() {
    generation++
    unsubscribe?.()
    unsubscribe = undefined
    capture?.stop()
    capture = null
    queue?.cancel()
    queue = null
    if (token) void window.desktop?.local?.cancel(token).catch(() => {})
    token = null
    busy.value = false
  }

  function interrupt(reason: string) {
    error.value =
      store.session.status === 'Listening'
        ? `已自动暂停：${reason}。当前记录已保留；暂停期间不采集音频。`
        : reason
    release()
    if (store.session.status === 'Listening') store.pause()
  }

  async function begin(resume = false) {
    if (
      busy.value ||
      (resume
        ? store.session.status !== 'Paused'
        : !['Ready', 'Stopped'].includes(store.session.status))
    )
      return
    const bridge = window.desktop?.local
    if (!bridge) {
      error.value = '当前桌面版本尚未提供本地翻译'
      return
    }
    release()
    error.value = ''
    busy.value = true
    token = crypto.randomUUID()
    const currentToken = token
    const currentGeneration = generation
    try {
      await bridge.prepare(currentToken)
      if (currentGeneration !== generation) return
      if (!resume) nextId = 0
      const segmenter = new SpeechSegmenter()
      const idBase = nextId
      const timeOffset = resume ? store.elapsed : 0
      let resampler: StreamingResampler | null = null
      let epoch = 0
      let failedSegments = 0
      unsubscribe = bridge.onRecognized?.((result) => {
        if (currentGeneration !== generation || result.token !== currentToken) return
        const previous = store.session.captions.find((caption) => caption.id === result.id)
        // Do not erase a translated pair on every new interim recognition.
        if (previous?.zh) return
        store.acceptLocal(
          { id: result.id, revision: result.revision * 2, time: result.time, final: false },
          { en: result.en, zh: '' },
          epoch,
        )
      })
      queue = new TranscriptQueue(
        (request) => bridge.transcribe(request),
        (result, request) => {
          store.acceptLocal({ ...request, revision: request.revision * 2 + 1 }, result, epoch)
          if (request.final) {
            failedSegments =
              result.error || (result.en && !result.zh && !result.pending) ? failedSegments + 1 : 0
            if (failedSegments >= 3) interrupt(`连续三段未能完成：${result.error || '翻译失败'}`)
          }
        },
        3,
        (failure) => interrupt(describeError(failure)),
        bridge.cancelRequest
          ? (request) => {
              void bridge.cancelRequest!({
                token: request.token,
                id: request.id,
                revision: request.revision,
              }).catch(() => {})
            }
          : undefined,
      )
      const pendingCapture = await MicrophoneCapture.start(
        (samples, rate) => {
          if (currentGeneration !== generation || store.session.status !== 'Listening') return
          try {
            resampler ??= new StreamingResampler(rate)
            for (const segment of segmenter.push(resampler.push(samples))) {
              const id = idBase + segment.id
              nextId = Math.max(nextId, id + 1)
              queue?.enqueue({
                token: currentToken,
                id,
                revision: segment.revision,
                final: segment.final,
                time: timeOffset + segment.time,
                terms: store.settings.terms,
                pcm: segment.pcm.buffer as ArrayBuffer,
              })
            }
          } catch (failure) {
            interrupt(describeError(failure))
          }
        },
        () => {
          if (currentGeneration === generation) interrupt('麦克风已断开，请检查设备后继续')
        },
      )
      if (currentGeneration !== generation) {
        pendingCapture.stop()
        return
      }
      capture = pendingCapture
      if (resume) store.resume()
      else {
        store.start()
      }
      epoch = store.session.epoch
      busy.value = false
    } catch (failure) {
      if (currentGeneration === generation) interrupt(describeError(failure))
    }
  }

  function pause() {
    release()
    error.value = ''
    store.pause()
  }

  function stop() {
    release()
    error.value = ''
    store.stop()
  }

  function clear() {
    release()
    if (store.session.status === 'Listening') store.pause()
    store.clear()
    nextId = 0
    error.value = ''
  }

  function cancelPreparing() {
    release()
    error.value = ''
  }

  return { busy, error, begin, pause, stop, clear, cancelPreparing, dispose: release }
}
