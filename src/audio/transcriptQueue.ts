import type { LocalAudioRequest, LocalTranscript } from '../../electron/local-types'

export class TranscriptQueue {
  private pending: LocalAudioRequest[] = []
  private active = false
  private activeRequest: LocalAudioRequest | null = null
  private superseded = false
  private generation = 0
  private waiters: Array<() => void> = []

  constructor(
    private readonly submit: (request: LocalAudioRequest) => Promise<LocalTranscript>,
    private readonly receive: (result: LocalTranscript, request: LocalAudioRequest) => void,
    private readonly maxPending = 3,
    private readonly fail: (error: unknown) => void = () => {},
    private readonly supersede?: (request: LocalAudioRequest) => void,
  ) {}

  enqueue(request: LocalAudioRequest): void {
    if (request.final) {
      // Final audio includes its Partials. Shed speculative work first, never a Final.
      this.pending = this.pending.filter((item) => item.final)
    } else {
      if (this.pending.some((item) => item.final)) return
      this.pending = this.pending.filter((item) => item.final)
    }
    if (this.pending.length >= this.maxPending) {
      if (!request.final) return
      throw new Error('本地处理持续积压，待处理音频未完成；请暂停课程，继续后重播遗漏内容')
    }
    this.pending.push(request)
    if (
      this.supersede &&
      !this.superseded &&
      this.activeRequest &&
      !this.activeRequest.final &&
      this.pending.some((item) => item.final && item.id === this.activeRequest!.id)
    ) {
      this.superseded = true
      this.supersede(this.activeRequest)
    }
    void this.drain()
  }

  cancel(): void {
    this.generation++
    this.pending = []
  }

  idle(): Promise<void> {
    if (!this.active && !this.pending.length) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    const generation = this.generation
    while (this.pending.length && generation === this.generation) {
      const request = this.pending.shift()!
      this.activeRequest = request
      this.superseded = false
      try {
        const result = await this.submit(request)
        if (generation === this.generation && !this.superseded) this.receive(result, request)
      } catch (error) {
        if (generation === this.generation && !this.superseded) {
          this.pending = []
          this.fail(error)
        }
      } finally {
        this.activeRequest = null
      }
    }
    this.active = false
    if (this.pending.length) void this.drain()
    else this.waiters.splice(0).forEach((resolve) => resolve())
  }
}
