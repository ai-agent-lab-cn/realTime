import { nextTick } from 'vue'
import type { LocalRequestKey } from '../../electron/local-types'
import type { RendererTiming, RendererTimingMetric } from '../../electron/diagnostic-types'
export interface AudioTimingBounds {
  speechStart: number
  speechEnd: number
  audioEnd: number
}
interface PendingFrame {
  request: LocalRequestKey
  captionId: number
  field: 'en' | 'zh' | 'final'
  at: number
  current: () => boolean
}
const key = (r: LocalRequestKey) => `${r.id}:${r.revision}`
function frameAfterDom(callback: () => void): () => void {
  let disposed = false,
    frame = 0
  void nextTick(() => {
    if (!disposed && typeof requestAnimationFrame === 'function')
      frame = requestAnimationFrame(() => {
        if (!disposed) callback()
      })
  })
  return () => {
    disposed = true
    if (frame) cancelAnimationFrame(frame)
  }
}
/** All elapsed values use the renderer's monotonic clock. Sample-time additions
 * estimate the energy-detected speech origin; a RAF is a paint opportunity,
 * not proof of physical pixels appearing. No audio or text enters this class. */
export class LocalRenderTimings {
  private requests = new Map<string, AudioTimingBounds & { queued: number; submitted?: number }>()
  private origins = new Map<number, number>()
  private pending = new Map<string, { latest: PendingFrame; cancel: () => void }>()
  private reported = new Set<string>()
  private disposed = false
  constructor(
    private token: string,
    private send: (event: RendererTiming) => void,
    private active: () => boolean,
    private now: () => number = () => performance.now(),
    private frame: (callback: () => void) => () => void = frameAfterDom,
  ) {}
  enqueued(request: LocalRequestKey, bounds: AudioTimingBounds) {
    if (this.disposed || this.requests.size >= 4096) return
    this.requests.set(key(request), { ...bounds, queued: this.now() })
  }
  private metric(
    request: LocalRequestKey,
    metric: RendererTimingMetric,
    value: number,
    captionId?: number,
  ) {
    if (this.disposed || !this.active() || !Number.isFinite(value) || value < 0) return
    const id = `${key(request)}:${metric}`
    if (this.reported.has(id)) return
    this.reported.add(id)
    try {
      this.send({
        token: this.token,
        id: request.id,
        revision: request.revision,
        metric,
        value,
        ...(captionId === undefined ? {} : { captionId }),
      })
    } catch {
      /* Diagnostics do not block capture. */
    }
  }
  submitted(request: LocalRequestKey) {
    const data = this.requests.get(key(request))
    if (!data) return
    data.submitted = this.now()
    this.metric(request, 'audioAccumulationMs', (data.audioEnd - data.speechStart) * 1000)
    this.metric(request, 'asrQueueMs', data.submitted - data.queued)
  }
  acknowledged(request: LocalRequestKey) {
    const data = this.requests.get(key(request))
    if (data?.submitted !== undefined)
      this.metric(request, 'roundTripMs', this.now() - data.submitted)
  }
  changed(
    request: LocalRequestKey,
    captionId: number,
    field: 'en' | 'zh' | 'final',
    current: () => boolean,
  ) {
    if (
      this.disposed ||
      !this.active() ||
      this.reported.has(
        `${key(request)}:${field === 'en' ? 'englishRenderMs' : field === 'zh' ? 'chineseRenderMs' : 'speechEndToFinalMs'}`,
      )
    )
      return
    const data = this.requests.get(key(request))
    if (!data) return
    this.origins.set(captionId, Math.min(this.origins.get(captionId) ?? Infinity, data.speechStart))
    const id = `${captionId}:${field}`,
      latest = { request, captionId, field, at: this.now(), current }
    const existing = this.pending.get(id)
    if (existing) {
      existing.latest = latest
      return
    }
    const entry = { latest, cancel: () => {} }
    this.pending.set(id, entry)
    entry.cancel = this.frame(() => {
      this.pending.delete(id)
      const item = entry.latest,
        bounds = this.requests.get(key(item.request))
      if (!bounds || this.disposed || !this.active() || !item.current()) return
      const now = this.now(),
        sinceEnqueue = now - bounds.queued
      if (item.field === 'en') {
        this.metric(item.request, 'englishRenderMs', now - item.at, item.captionId)
        this.metric(
          item.request,
          'speechToEnglishMs',
          (bounds.audioEnd - this.origins.get(item.captionId)!) * 1000 + sinceEnqueue,
          item.captionId,
        )
      } else if (item.field === 'zh') {
        this.metric(item.request, 'chineseRenderMs', now - item.at, item.captionId)
        this.metric(
          item.request,
          'speechToChineseMs',
          (bounds.audioEnd - this.origins.get(item.captionId)!) * 1000 + sinceEnqueue,
          item.captionId,
        )
      } else
        this.metric(
          item.request,
          'speechEndToFinalMs',
          (bounds.audioEnd - bounds.speechEnd) * 1000 + sinceEnqueue,
          item.captionId,
        )
    })
  }
  dispose() {
    this.disposed = true
    for (const task of this.pending.values()) task.cancel()
    this.pending.clear()
    this.requests.clear()
    this.origins.clear()
    this.reported.clear()
  }
}
