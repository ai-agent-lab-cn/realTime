import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalRequestKey } from './local-types.js'
import { validateToken } from './local-processing.js'

import type {
  MainTimingStage,
  RendererTimingMetric,
  RendererTiming,
  DiagnosticMetric,
  DiagnosticRequest,
  DiagnosticReport,
} from './diagnostic-types.js'
export type {
  MainTimingStage,
  RendererTimingMetric,
  RendererTiming,
  DiagnosticMetric,
  DiagnosticRequest,
  DiagnosticReport,
} from './diagnostic-types.js'
const stages: readonly string[] = [
  'received',
  'asrStart',
  'asrEnd',
  'qualityEnd',
  'englishNotified',
  'mtQueued',
  'mtStart',
  'mtFirst',
  'mtUnit',
  'complete',
  'rejected',
  'cancelled',
  'failed',
]
const metrics: readonly string[] = [
  'audioAccumulationMs',
  'asrQueueMs',
  'roundTripMs',
  'englishRenderMs',
  'chineseRenderMs',
  'speechToEnglishMs',
  'speechToChineseMs',
  'speechEndToFinalMs',
]
const integer = (v: unknown, minimum = 0): v is number =>
  Number.isSafeInteger(v) && (v as number) >= minimum
const duration = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 3600000
const firstDisplay = (metric: string) =>
  metric === 'speechToEnglishMs' || metric === 'speechToChineseMs'

export class LocalDiagnostics {
  private token = ''
  private started = 0
  private data: DiagnosticReport | null = null
  private rows = new Map<string, DiagnosticRequest>()
  private displays = new Map<string, { metric: RendererTimingMetric; value: number }>()
  constructor(private now: () => number = () => performance.now()) {}

  prepare(token: string, source: 'microphone' | 'fixture' = 'microphone'): void {
    validateToken(token)
    this.token = token
    this.started = this.now()
    this.rows.clear()
    this.displays.clear()
    this.data = {
      version: 1,
      runId: randomUUID(),
      createdAt: new Date().toISOString(),
      source: source === 'fixture' ? 'fixture' : 'microphone',
      finished: false,
      truncated: false,
      requests: [],
      summary: {},
    }
  }

  private row(key: LocalRequestKey): DiagnosticRequest | undefined {
    if (
      !key ||
      key.token !== this.token ||
      !this.data ||
      this.data.finished ||
      !integer(key.id) ||
      !integer(key.revision, 1)
    )
      return
    const id = `${key.id}:${key.revision}`
    let row = this.rows.get(id)
    if (!row) {
      if (this.rows.size >= 4096) {
        this.data.truncated = true
        return
      }
      row = { id: key.id, revision: key.revision, stages: {}, metrics: {}, mtUnits: 0 }
      this.rows.set(id, row)
    }
    return row
  }

  mark(key: LocalRequestKey, stage: MainTimingStage): void {
    if (!stages.includes(stage)) return
    const row = this.row(key)
    if (!row) return
    const elapsed = this.now() - this.started
    if (!Number.isFinite(elapsed) || elapsed < 0) return
    row.stages[stage] ??= elapsed
    if (stage === 'mtUnit') row.mtUnits++
  }

  metric(value: RendererTiming): boolean {
    if (
      !value ||
      !metrics.includes(value.metric) ||
      !duration(value.value) ||
      (value.captionId !== undefined && !integer(value.captionId))
    )
      return false
    const row = this.row(value)
    if (!row) return false
    if (row.metrics[value.metric] !== undefined) return true
    row.metrics[value.metric] = value.value
    if (value.captionId !== undefined) row.captionId ??= value.captionId
    if (firstDisplay(value.metric)) {
      const caption =
        value.captionId === undefined ? `request:${value.id}` : `caption:${value.captionId}`
      const id = `${value.metric}:${caption}`
      if (!this.displays.has(id))
        this.displays.set(id, { metric: value.metric, value: value.value })
    }
    return true
  }

  finish(token: string): DiagnosticReport | null {
    if (!this.data || token !== this.token) return null
    if (!this.data.finished) {
      for (const row of this.rows.values()) {
        if (
          !['complete', 'rejected', 'cancelled', 'failed'].some(
            (stage) => row.stages[stage as MainTimingStage] !== undefined,
          )
        )
          this.mark({ token, id: row.id, revision: row.revision }, 'cancelled')
      }
      this.data.finished = true
    }
    return this.report()
  }

  report(): DiagnosticReport | null {
    if (!this.data) return null
    const samples = new Map<DiagnosticMetric, number[]>()
    const add = (metric: DiagnosticMetric, value: number | undefined) => {
      if (duration(value)) {
        const list = samples.get(metric) ?? []
        list.push(value)
        samples.set(metric, list)
      }
    }
    const pairs = [
      ['asrMs', 'asrStart', 'asrEnd'],
      ['qualityMs', 'asrEnd', 'qualityEnd'],
      ['mtQueueMs', 'mtQueued', 'mtStart'],
      ['mtFirstMs', 'mtStart', 'mtFirst'],
      ['mtTotalMs', 'mtStart', 'complete'],
    ] as const
    for (const row of this.rows.values()) {
      for (const [metric, start, end] of pairs) {
        if (
          metric === 'mtTotalMs' &&
          ['failed', 'cancelled', 'rejected'].some(
            (stage) => row.stages[stage as MainTimingStage] !== undefined,
          )
        )
          continue
        const from = row.stages[start],
          to = row.stages[end]
        if (from !== undefined && to !== undefined) add(metric, to - from)
      }
      for (const metric of metrics as readonly RendererTimingMetric[])
        if (!firstDisplay(metric)) add(metric, row.metrics[metric])
    }
    for (const sample of this.displays.values()) add(sample.metric, sample.value)
    const summary: DiagnosticReport['summary'] = {}
    for (const [metric, values] of samples) {
      values.sort((a, b) => a - b)
      const percentile = (p: number) => {
        const index = (values.length - 1) * p,
          low = Math.floor(index)
        return values[low]! + (values[Math.ceil(index)]! - values[low]!) * (index - low)
      }
      summary[metric] = { n: values.length, median: percentile(0.5), p95: percentile(0.95) }
    }
    return structuredClone({ ...this.data, requests: [...this.rows.values()], summary })
  }
}

export async function saveDiagnostics(
  report: DiagnosticReport,
  directory: string,
): Promise<string> {
  validateToken(report.runId)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${report.runId}.json`)
  try {
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return path
}
