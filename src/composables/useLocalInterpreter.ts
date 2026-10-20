import type { LocalAudioRequest, LocalTranscript } from '../../electron/local-types'
import { ref } from 'vue'
import { useInterpreter } from '../stores/interpreter'
import { MicrophoneCapture } from '../audio/microphone'
import { StreamingResampler } from '../audio/resample'
import { SpeechSegmenter } from '../audio/segmenter'
import { TranscriptQueue } from '../audio/transcriptQueue'
import { LocalRenderTimings } from '../audio/localTiming'

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
  let activeTimings: LocalRenderTimings | undefined
  let unsubscribe: (() => void) | undefined
  let unsubscribeTranslation: (() => void) | undefined

  function release() {
    generation++
    activeTimings?.dispose()
    activeTimings = undefined
    unsubscribe?.()
    unsubscribe = undefined
    unsubscribeTranslation?.()
    unsubscribeTranslation = undefined
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
      const pipeline = !!(bridge.recognize && bridge.onTranslated)
      const timing = bridge.recordTiming
        ? new LocalRenderTimings(
            currentToken,
            (value) => {
              void bridge.recordTiming!(value).catch(() => {})
            },
            () => currentGeneration === generation && store.session.status === 'Listening',
          )
        : undefined
      activeTimings = timing
      function updateCaption(
        request: Omit<LocalAudioRequest, 'pcm'>,
        result: LocalTranscript,
        apply: () => void,
      ) {
        const id = result.caption?.id ?? request.id
        const before = store.session.captions.find((c) => c.id === id)
        const previous = { en: before?.en, zh: before?.zh, final: before?.final }
        apply()
        const after = store.session.captions.find((c) => c.id === id)
        if (!after || !timing) return
        for (const field of ['en', 'zh', 'final'] as const) {
          const expected = after[field]
          if (expected && expected !== previous[field])
            timing.changed(
              request,
              id,
              field,
              () => store.session.captions.find((c) => c.id === id)?.[field] === expected,
            )
        }
      }
      // Keep routing metadata only: retaining cumulative PCM here grows without bound.
      type RequestMetadata = Omit<LocalAudioRequest, 'pcm'>
      const requests = new Map<string, RequestMetadata>()
      const finalOutcomes = new Map<
        number,
        { outcome?: 'success' | 'failure' | 'neutral'; reason?: string }
      >()
      const finalOrder: number[] = []
      let finalCursor = 0
      const key = (request: { id: number; revision: number }) => `${request.id}:${request.revision}`
      function outcome(request: RequestMetadata, result: LocalTranscript) {
        if (!request.final) return
        const entry = finalOutcomes.get(request.id)
        if (!entry || entry.outcome) return
        entry.outcome =
          result.error || (result.en && !result.zh && !result.pending)
            ? 'failure'
            : result.en && result.zh && !result.pending
              ? 'success'
              : 'neutral'
        entry.reason = result.error || '翻译失败'
        while (finalCursor < finalOrder.length) {
          const next = finalOutcomes.get(finalOrder[finalCursor])!
          if (!next.outcome) break
          finalCursor++
          if (next.outcome === 'failure') failedSegments++
          if (next.outcome === 'success') failedSegments = 0
          if (failedSegments >= 3) {
            interrupt(`连续三段未能完成：${next.reason}`)
            break
          }
        }
      }
      unsubscribe = bridge.onRecognized?.((result) => {
        if (currentGeneration !== generation || result.token !== currentToken) return
        if (pipeline) {
          const request = requests.get(key(result))
          if (request) {
            const value = { en: result.en, zh: '', caption: result.caption }
            updateCaption(request, value, () => store.recognizeLocal(request, value, epoch))
          }
          return
        }
        const previous = store.session.captions.find((caption) => caption.id === result.id)
        // Do not erase a translated pair on every new interim recognition.
        if (previous?.zh) return
        store.acceptLocal(
          { id: result.id, revision: result.revision * 2, time: result.time, final: false },
          { en: result.en, zh: '' },
          epoch,
        )
      })
      let activeRequest: LocalAudioRequest | null = null
      unsubscribeTranslation = bridge.onTranslated?.((result) => {
        if (pipeline) {
          if (currentGeneration !== generation || result.token !== currentToken) return
          const request = requests.get(key(result))
          if (!request) return
          const complete = result.phase === 'complete'
          updateCaption(request, result, () =>
            store.translateLocal(
              { ...request, final: result.audioFinal ?? request.final },
              result,
              epoch,
              complete,
            ),
          )
          if (complete) {
            requests.delete(key(result))
            if (request.final) {
              // Serial MT has passed this audio window: its old Partials can no
              // longer produce useful results, including silently coalesced work.
              for (const [requestKey, pending] of requests) {
                if (!pending.final && pending.id <= request.id) requests.delete(requestKey)
              }
            }
            if (result.error && /积压|队列.*满/.test(result.error)) interrupt(result.error)
            else outcome(request, result)
          }
          return
        }
        if (
          currentGeneration !== generation ||
          result.token !== currentToken ||
          activeRequest?.id !== result.id ||
          activeRequest?.revision !== result.revision
        )
          return
        store.acceptLocal(
          { id: result.id, revision: result.revision * 2, time: result.time, final: false },
          { ...result, pending: true },
          epoch,
          true,
        )
      })
      queue = new TranscriptQueue(
        async (request) => {
          activeRequest = request
          timing?.submitted(request)
          if (pipeline) {
            const { pcm: _pcm, ...metadata } = request
            requests.set(key(request), metadata)
            if (request.final && !finalOutcomes.has(request.id)) {
              finalOutcomes.set(request.id, {})
              finalOrder.push(request.id)
            }
          }
          try {
            return await (pipeline ? bridge.recognize!(request) : bridge.transcribe(request))
          } finally {
            timing?.acknowledged(request)
            if (activeRequest === request) activeRequest = null
          }
        },
        (result, request) => {
          if (pipeline) {
            updateCaption(request, result, () => store.recognizeLocal(request, result, epoch, true))
            if (result.error && /积压|队列.*满/.test(result.error)) interrupt(result.error)
            else if (
              result.error ||
              (!result.en && !result.pending) ||
              result.translationQueued === false
            ) {
              requests.delete(key(request))
              outcome(request, result)
            }
            return
          }
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
              if (activeRequest === request) activeRequest = null
              requests.delete(key(request))
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
              const request = {
                token: currentToken,
                id,
                revision: segment.revision,
                final: segment.final,
                time: timeOffset + segment.time,
                terms: store.settings.terms,
                pcm: segment.pcm.buffer as ArrayBuffer,
              }
              timing?.enqueued(request, {
                speechStart: timeOffset + segment.speechStart,
                speechEnd: timeOffset + segment.speechEnd,
                audioEnd: timeOffset + segment.end,
              })
              queue?.enqueue(request)
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
