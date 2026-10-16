import {
  questionPunctuation,
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
import type { LocalAudioRequest, LocalTranscript, LocalRequestKey } from './local-types.js'
export interface Models {
  prepare(): Promise<void>
  recognize(pcm: ArrayBuffer, terms: boolean, signal: AbortSignal): Promise<string>
  translate(text: string, terms: boolean, signal: AbortSignal): Promise<string>
  close(): void
}
export class LocalRuntime {
  private token: string | null = null
  private ready = false
  private cached: { id: number; terms: boolean; en: string; zh: string } | null = null
  private carry: {
    id: number
    revision: number
    time: number
    end: number
    terms: boolean
    en: string
    zh: string
  } | null = null
  private job: AbortController | null = null
  private request: LocalRequestKey | null = null
  constructor(private models: Models) {}
  get active() {
    return this.ready && this.token !== null
  }
  async prepare(token: string) {
    validateToken(token)
    this.job?.abort()
    this.token = token
    this.cached = null
    this.carry = null
    this.ready = false
    await this.models.prepare()
    if (this.token !== token) throw new Error('本轮已取消')
    this.ready = true
  }
  cancel(token: string) {
    validateToken(token)
    if (this.token === token) {
      if (!this.ready) this.models.close()
      this.carry = null
      this.token = null
      this.ready = false
      this.job?.abort()
      this.job = null
    }
  }
  cancelRequest(request: LocalRequestKey) {
    validateToken(request?.token)
    if (
      this.token === request.token &&
      this.request?.id === request.id &&
      this.request?.revision === request.revision
    )
      this.job?.abort()
  }
  async transcribe(
    request: LocalAudioRequest,
    onRecognized?: (en: string) => void,
  ): Promise<LocalTranscript> {
    validateAudio(request)
    if (!this.active || this.token !== request.token) throw new Error('音频会话已结束')
    if (this.job) throw new Error('本地推理忙，请暂停后重试')
    const controller = new AbortController()
    this.job = controller
    this.request = { token: request.token, id: request.id, revision: request.revision }
    const valid = () => {
      if (controller.signal.aborted || this.token !== request.token) throw new Error('本轮已取消')
    }
    try {
      const raw = await this.models.recognize(request.pcm, request.terms, controller.signal)
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
        if (!carry) return { en: '', zh: '' }
        if (request.final) this.carry = null
        return { en: carry.en, zh: carry.zh, pending: true, caption }
      }
      const duration = request.pcm.byteLength / 4 / 16000
      const issue = transcriptIssue(current, duration)
      if (issue) {
        if (request.final) this.carry = null
        return { en: '', zh: '', error: issue, caption }
      }
      const en = questionPunctuation(carry ? joinContinuation(carry.en, current) : current)
      // A pause ends an audio window, but does not complete an unfinished clause.
      const hold = !carry && request.final && hasOpenTail(en)
      const prefix = completePrefix(en)
      const pending =
        hold ||
        ((!request.final || !!carry) && hasOpenTail(en)) ||
        (!request.final && !!prefix && prefix !== en)
      const translationText = pending ? prefix : en
      // A continuation updates the original caption via the response, not a new early row.
      if (!carry) onRecognized?.(en)
      const finish = (zh: string, error?: string): LocalTranscript => {
        valid()
        if (request.final)
          this.carry = hold
            ? {
                id: request.id,
                revision: request.revision,
                time: request.time,
                end: request.time + duration,
                terms: request.terms,
                en,
                zh,
              }
            : null
        return {
          en,
          zh,
          ...(pending ? { pending: true } : {}),
          ...(caption ? { caption } : {}),
          ...(error ? { error } : {}),
        }
      }
      if (!translationText) return finish('')
      if (
        this.cached?.id === request.id &&
        this.cached.en === translationText &&
        this.cached.terms === request.terms
      )
        return finish(this.cached.zh)
      try {
        const zh = await this.models.translate(translationText, request.terms, controller.signal)
        valid()
        if (!zh.trim()) throw new Error('空翻译')
        const translated = request.terms ? normalizeTerms(zh) : zh
        this.cached = { id: request.id, terms: request.terms, en: translationText, zh: translated }
        return finish(translated)
      } catch (error) {
        valid()
        const reason =
          error instanceof Error && error.name === 'TimeoutError' ? '本段翻译超时' : '本段翻译失败'
        return finish('', `${reason}，原文已保留为未确认字幕`)
      }
    } finally {
      if (this.job === controller) {
        this.job = null
        this.request = null
      }
    }
  }
  close() {
    this.carry = null
    this.token = null
    this.ready = false
    this.job?.abort()
    this.job = null
    this.models.close()
  }
}
