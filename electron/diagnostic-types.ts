import type { LocalRequestKey } from './local-types.js'

export type MainTimingStage =
  | 'received'
  | 'asrStart'
  | 'asrEnd'
  | 'qualityEnd'
  | 'englishNotified'
  | 'mtQueued'
  | 'mtStart'
  | 'mtFirst'
  | 'mtUnit'
  | 'complete'
  | 'rejected'
  | 'cancelled'
  | 'failed'
export type RendererTimingMetric =
  | 'audioAccumulationMs'
  | 'asrQueueMs'
  | 'roundTripMs'
  | 'englishRenderMs'
  | 'chineseRenderMs'
  | 'speechToEnglishMs'
  | 'speechToChineseMs'
  | 'speechEndToFinalMs'
export interface RendererTiming extends LocalRequestKey {
  metric: RendererTimingMetric
  value: number
  captionId?: number
}
export type DiagnosticMetric =
  RendererTimingMetric | 'asrMs' | 'qualityMs' | 'mtQueueMs' | 'mtFirstMs' | 'mtTotalMs'
export interface DiagnosticRequest {
  id: number
  revision: number
  captionId?: number
  stages: Partial<Record<MainTimingStage, number>>
  metrics: Partial<Record<RendererTimingMetric, number>>
  mtUnits: number
}
export interface DiagnosticReport {
  version: 1
  runId: string
  createdAt: string
  source: 'microphone' | 'fixture'
  finished: boolean
  truncated: boolean
  requests: DiagnosticRequest[]
  summary: Partial<Record<DiagnosticMetric, { n: number; median: number; p95: number }>>
}
