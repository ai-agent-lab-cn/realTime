import {
  questionPunctuation,
  needsContinuation,
  hasOpenTail,
  completePrefix,
  joinContinuation,
} from './translation-units.js'
import {
  cleanTranscript,
  transcriptIssue,
  normalizeTerms,
  validateAudio,
  validateToken,
} from './local-processing.js'
import { TranslationScheduler } from './translation-scheduler.js'
import { TranslationMemory, translationKey } from './translation-memory.js'
import type { MainTimingStage } from './diagnostic-types.js'
import type {
  LocalAudioRequest,
  LocalTranscript,
  LocalRequestKey,
  CompletedTranslationUnit,
} from './local-types.js'
export interface Models {
  prepare(): Promise<void>
  recognize(pcm: ArrayBuffer, terms: boolean, signal: AbortSignal): Promise<string>
  translate(
    text: string,
    terms: boolean,
    signal: AbortSignal,
    onProgress?: (text: string) => void,
  ): Promise<string>
  close(): void
}
type Recognized = (en: string, caption?: LocalTranscript['caption']) => void
type ResultListener = (result: LocalTranscript) => void
interface RequestJob {
  request: LocalRequestKey
  controller: AbortController
  final: boolean
}
export class LocalRuntime {
  private token: string | null = null
  private ready = false
  private carry: {
    id: number
    revision: number
    time: number
    end: number
    terms: boolean
    en: string
  } | null = null
  private asr: AbortController | null = null
  private asrDone: Promise<void> | null = null
  private jobs = new Map<string, RequestJob>()
  private translations = new TranslationScheduler()
  private memory = new TranslationMemory()
  constructor(
    private models: Models,
    private onTiming?: (key: LocalRequestKey, stage: MainTimingStage) => void,
  ) {}
  private observe(key: LocalRequestKey, stage: MainTimingStage) {
    try {
      this.onTiming?.({ token: key.token, id: key.id, revision: key.revision }, stage)
    } catch {
      /* Diagnostics must not affect interpretation. */
    }
  }
  get active() {
    return this.ready && this.token !== null
  }
  async prepare(token: string) {
    validateToken(token)
    this.abortJobs()
    this.token = token
    this.memory.clear()
    this.carry = null
    this.ready = false
    if (this.asrDone) await this.asrDone
    if (this.token !== token) throw new Error('本轮已取消')
    await this.models.prepare()
    if (this.token !== token) throw new Error('本轮已取消')
    this.ready = true
  }
  cancel(token: string) {
    validateToken(token)
    if (this.token === token) {
      if (!this.ready) this.models.close()
      this.carry = null
      this.memory.clear()
      this.token = null
      this.ready = false
      this.abortJobs()
    }
  }
  cancelRequest(request: LocalRequestKey) {
    validateToken(request?.token)
    if (this.token !== request.token) return
    const job = this.jobs.get(this.requestKey(request))
    if (job && !job.final) {
      this.observe(request, 'cancelled')
      job.controller.abort()
    }
  }
  async recognize(
    request: LocalAudioRequest,
    onRecognized?: Recognized,
    onTranslated?: ResultListener,
    onComplete?: ResultListener,
  ): Promise<LocalTranscript> {
    const result = await this.start(request, onRecognized, onTranslated, onComplete)
    return { ...result.ack, translationQueued: !!result.completion }
  }
  async transcribe(
    request: LocalAudioRequest,
    onRecognized?: Recognized,
    onTranslated?: ResultListener,
  ): Promise<LocalTranscript> {
    const result = await this.start(request, onRecognized, onTranslated)
    return result.completion ? await result.completion : result.ack
  }
  private requestKey(request: LocalRequestKey) {
    return `${request.token}:${request.id}:${request.revision}`
  }
  private abortJobs() {
    for (const job of this.jobs.values()) {
      this.observe(job.request, 'cancelled')
      job.controller.abort()
    }
    this.jobs.clear()
    // Keep the ASR lock until native recognition actually settles after cancellation.
  }
  private async start(
    request: LocalAudioRequest,
    onRecognized?: Recognized,
    onTranslated?: ResultListener,
    onComplete?: ResultListener,
  ): Promise<{ ack: LocalTranscript; completion?: Promise<LocalTranscript> }> {
    validateAudio(request)
    if (!this.active || this.token !== request.token) throw new Error('音频会话已结束')
    if (this.asr) throw new Error('本地识别忙，请暂停后重试')
    const key = this.requestKey(request)
    if (this.jobs.has(key)) throw new Error('本地请求正在处理中')
    const controller = new AbortController()
    this.asr = controller
    let finishAsr!: () => void
    this.asrDone = new Promise<void>((resolve) => {
      finishAsr = resolve
    })
    this.jobs.set(key, {
      controller,
      final: request.final,
      request: { token: request.token, id: request.id, revision: request.revision },
    })
    const valid = () => {
      if (controller.signal.aborted || this.token !== request.token) throw new Error('本轮已取消')
    }
    const cleanup = () => {
      if (this.jobs.get(key)?.controller === controller) this.jobs.delete(key)
    }
    let scheduled = false
    try {
      this.observe(request, 'asrStart')
      const raw = await this.models.recognize(request.pcm, request.terms, controller.signal)
      this.observe(request, 'asrEnd')
      valid()
      const clean = cleanTranscript(raw)
      const current = request.terms ? normalizeTerms(clean) : clean
      const previous = this.carry
      const carry =
        previous &&
        request.id === previous.id + 1 &&
        request.terms === previous.terms &&
        request.time >= previous.time &&
        Math.abs(request.time - previous.end) <= 1
          ? previous
          : null
      if (previous && !carry) this.carry = null
      const caption = carry
        ? { id: carry.id, revision: carry.revision + request.revision, time: carry.time }
        : undefined
      if (!current) {
        if (!carry) {
          this.observe(request, 'complete')
          return { ack: { en: '', zh: '' } }
        }
        if (request.final) this.carry = null
        this.observe(request, 'complete')
        return { ack: { en: carry.en, zh: '', pending: true, caption } }
      }
      const provisional = carry ? joinContinuation(carry.en, current) : current
      const duration = request.pcm.byteLength / 4 / 16000
      const issue = transcriptIssue(current, duration)
      this.observe(request, 'qualityEnd')
      if (issue) {
        this.observe(request, 'rejected')
        if (request.final) this.carry = null
        return { ack: { en: '', zh: '', error: issue, ...(caption ? { caption } : {}) } }
      }
      // Latest project rule: reject suspect text before early display, while
      // keeping English independent from semantic planning and MT completion.
      this.observe(request, 'englishNotified')
      onRecognized?.(provisional, caption)
      valid()
      const en = questionPunctuation(provisional)
      const hold = !carry && request.final && needsContinuation(en)
      const prefix = completePrefix(en)
      const pending =
        hold ||
        ((!request.final || !!carry) && needsContinuation(en)) ||
        (!request.final && !!prefix && prefix !== en)
      const translationText =
        pending && hasOpenTail(en)
          ? prefix
          : !request.final && prefix && prefix !== en
            ? prefix
            : en
      // Carry belongs to ASR order; a late translation never mutates it.
      if (request.final)
        this.carry = hold
          ? {
              id: request.id,
              revision: request.revision,
              time: request.time,
              end: request.time + duration,
              terms: request.terms,
              en,
            }
          : null
      let completedUnits: CompletedTranslationUnit[] = []
      const finish = (zh: string, error?: string): LocalTranscript => ({
        en,
        ...(completedUnits.length && zh ? { units: completedUnits } : {}),
        zh,
        ...(pending ? { pending: true } : {}),
        ...(caption ? { caption } : {}),
        ...(error ? { error } : {}),
      })
      if (!translationText) {
        this.observe(request, 'complete')
        return { ack: finish('') }
      }
      this.observe(request, 'mtQueued')
      let firstOutput = true,
        unitCount = 0
      const completion = this.translations
        .run(
          `${request.token}:${caption?.id ?? request.id}`,
          request.final,
          controller.signal,
          async (signal) => {
            valid()
            this.observe(request, 'mtStart')
            const zh = await this.memory.translate(
              translationText,
              request.terms,
              signal,
              (text, terms, nativeSignal, progress) =>
                this.models.translate(text, terms, nativeSignal, progress),
              (text, units) => {
                if (
                  signal.aborted ||
                  controller.signal.aborted ||
                  this.token !== request.token ||
                  !text.trim()
                )
                  return
                if (firstOutput) {
                  this.observe(request, 'mtFirst')
                  firstOutput = false
                }
                while (unitCount < units.length) {
                  this.observe(request, 'mtUnit')
                  unitCount++
                }
                completedUnits = units.map((unit) => ({
                  ...unit,
                  zh: request.terms ? normalizeTerms(unit.zh) : unit.zh,
                }))
                onTranslated?.({
                  en,
                  units: completedUnits,
                  zh: request.terms ? normalizeTerms(text) : text,
                  pending: true,
                  ...(caption ? { caption } : {}),
                })
              },
            )
            valid()
            if (!zh.trim()) throw new Error('空翻译')
            const translated = request.terms ? normalizeTerms(zh) : zh
            return translated
          },
          translationKey(translationText, request.terms),
        )
        .then((zh) => {
          valid()
          return finish(zh)
        })
        .catch((error: unknown) => {
          valid()
          if (error instanceof Error && error.name === 'AbortError') throw error
          const reason =
            error instanceof Error && error.message.includes('积压')
              ? '本段翻译积压超过上限'
              : error instanceof Error && error.name === 'TimeoutError'
                ? '本段翻译超时'
                : '本段翻译失败'
          return finish('', `${reason}，原文已保留为未确认字幕`)
        })
        .then((result) => {
          valid()
          this.observe(request, result.error ? 'failed' : 'complete')
          onComplete?.(result)
          return result
        })
        .finally(cleanup)
      // recognize owns this detached promise; transcribe may additionally await it.
      void completion.catch(() => {})
      scheduled = true
      return { ack: { en, zh: '', pending: true, ...(caption ? { caption } : {}) }, completion }
    } catch (error) {
      this.observe(request, controller.signal.aborted ? 'cancelled' : 'failed')
      throw error
    } finally {
      if (this.asr === controller) {
        this.asr = null
        this.asrDone = null
      }
      finishAsr()
      if (!scheduled) cleanup()
    }
  }
  close() {
    this.carry = null
    this.memory.clear()
    this.token = null
    this.ready = false
    this.abortJobs()
    this.models.close()
  }
}
