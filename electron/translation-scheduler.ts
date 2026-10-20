interface TranslationJob {
  key: string
  final: boolean
  source?: string
  controller: AbortController
  execute: () => Promise<void>
  reject: (error: Error) => void
  cleanup: () => void
}

/** Serializes native MT, including the period while canceled native work unwinds. */
export class TranslationScheduler {
  private active: TranslationJob | null = null
  private pending: TranslationJob[] = []

  run<T>(
    key: string,
    final: boolean,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
    source?: string,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(this.canceled())
    // A changed Final preempts speculative work. Identical source can finish
    // once, then the queued Final consumes its session-local cached result.
    if (
      final &&
      this.active?.key === key &&
      !this.active.final &&
      (source === undefined || this.active.source !== source)
    )
      this.cancel(this.active)
    for (const job of [...this.pending]) {
      if (!job.final && (!final || job.key === key)) this.cancel(job)
    }
    if (final && this.pending.filter((job) => job.final).length >= 3)
      return Promise.reject(new Error('翻译积压超过上限，本段原文已保留为未确认字幕'))

    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const onAbort = () => this.cancel(job)
      const job: TranslationJob = {
        key,
        final,
        source,
        controller,
        reject,
        cleanup: () => signal.removeEventListener('abort', onAbort),
        execute: async () => {
          try {
            const value = await work(controller.signal)
            if (!controller.signal.aborted) resolve(value)
          } catch (error) {
            reject(error)
          } finally {
            job.cleanup()
          }
        },
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.pending.push(job)
      this.pump()
    })
  }

  private canceled() {
    return new DOMException('本轮已取消或请求已被更新', 'AbortError')
  }

  private cancel(job: TranslationJob) {
    job.controller.abort()
    job.reject(this.canceled())
    job.cleanup()
    this.pending = this.pending.filter((item) => item !== job)
  }

  private pump() {
    if (this.active) return
    const next = this.pending.shift()
    if (!next) return
    this.active = next
    void next.execute().finally(() => {
      if (this.active === next) this.active = null
      this.pump()
    })
  }
}
