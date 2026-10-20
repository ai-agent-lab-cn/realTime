import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as diagnostics from '../../electron/local-diagnostics'

const key = { token: '11111111-1111-4111-8111-111111111111', id: 0, revision: 1 }
it('records first stage times, derives durations and omits private inputs', () => {
  expect(diagnostics).toHaveProperty('LocalDiagnostics')
  let clock = 100
  const d = new diagnostics.LocalDiagnostics(() => clock)
  d.prepare(key.token)
  for (const [stage, at] of [
    ['received', 110],
    ['asrStart', 120],
    ['asrEnd', 150],
    ['qualityEnd', 160],
    ['mtQueued', 165],
    ['mtStart', 170],
    ['mtFirst', 190],
    ['mtUnit', 200],
    ['mtUnit', 210],
    ['complete', 220],
  ] as const) {
    clock = at
    d.mark({ ...key, text: 'secret text', pcm: [1, 2] } as typeof key, stage)
  }
  clock = 230
  d.mark(key, 'asrStart')
  const r = d.report()!
  expect(r.requests[0]).toMatchObject({
    id: 0,
    revision: 1,
    stages: { received: 10, asrStart: 20 },
    mtUnits: 2,
  })
  expect(r.summary).toMatchObject({
    asrMs: { n: 1, median: 30, p95: 30 },
    qualityMs: { median: 10 },
    mtQueueMs: { median: 5 },
    mtFirstMs: { median: 20 },
    mtTotalMs: { median: 50 },
  })
  expect(JSON.stringify(r)).not.toMatch(
    /11111111-1111-4111-8111-111111111111|secret text|pcm|token/,
  )
  expect(r.runId).not.toBe(key.token)
  expect(Number.isFinite(Date.parse(r.createdAt))).toBe(true)
})

it('validates renderer metrics and summarizes first caption display with interpolated percentiles', () => {
  const d = new diagnostics.LocalDiagnostics(() => 0)
  d.prepare(key.token, 'fixture')
  for (const [id, captionId, value] of [
    [0, 5, 10],
    [1, 5, 999],
    [2, 6, 30],
  ]) {
    expect(
      d.metric({ ...key, id: id!, captionId, metric: 'speechToEnglishMs', value: value! }),
    ).toBe(true)
  }
  expect(d.metric({ ...key, metric: 'roundTripMs', value: 25 })).toBe(true)
  expect(d.report()!.summary).toMatchObject({
    speechToEnglishMs: { n: 2, median: 20, p95: 29 },
    roundTripMs: { n: 1, median: 25 },
  })
  const valid = { ...key, metric: 'roundTripMs', value: 25 }
  for (const patch of [
    { token: 'old' },
    { metric: 'text' },
    { metric: '__proto__' },
    { value: NaN },
    { value: Infinity },
    { value: -1 },
    { value: 3600001 },
    { id: -1 },
    { id: 0.5 },
    { revision: NaN },
    { revision: 0 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { captionId: 1.5 },
  ]) {
    expect(d.metric({ ...valid, ...patch } as diagnostics.RendererTiming)).toBe(false)
  }
  expect(d.metric({ ...key, metric: 'roundTripMs', value: 3600000 })).toBe(true)
  expect(d.report()!.source).toBe('fixture')
  expect(d.report()!.requests[0]!.captionId).toBe(5)
  expect(d.report()!.requests[0]!.metrics.roundTripMs).toBe(25)
})

it('isolates sessions, freezes finish and cancels only unfinished requests', () => {
  let clock = 10
  const d = new diagnostics.LocalDiagnostics(() => clock)
  expect(d.report()).toBeNull()
  expect(() => d.prepare('invalid')).toThrow()
  d.prepare(key.token)
  d.mark(key, 'asrStart')
  d.mark(key, 'asrEnd')
  d.mark(key, 'complete') // No translation is a valid completed request.
  d.mark({ ...key, id: 1 }, 'mtStart')
  d.mark({ ...key, id: 2 }, 'failed')
  d.mark({ ...key, id: 3 }, 'rejected')
  d.mark({ ...key, id: 4 }, '__proto__' as diagnostics.MainTimingStage)
  expect(d.finish('old')).toBeNull()
  clock = 20
  const r = d.finish(key.token)!
  expect(r.requests).toHaveLength(4)
  expect(r.requests[0]!.stages.cancelled).toBeUndefined()
  expect(r.requests[1]!.stages.cancelled).toBe(10)
  expect(r.requests[2]!.stages.cancelled).toBeUndefined()
  expect(r.requests[3]!.stages.cancelled).toBeUndefined()
  expect(r.summary.mtTotalMs).toBeUndefined()
  d.mark(key, 'failed')
  expect(d.metric({ ...key, metric: 'roundTripMs', value: 50 })).toBe(false)
  r.requests[0]!.stages.complete = 999
  expect(d.finish(key.token)!.requests[0]!.stages.complete).toBe(0)
  d.prepare('22222222-2222-4222-8222-222222222222')
  d.mark(key, 'received')
  expect(d.report()!.requests).toEqual([])
  expect(d.report()!.runId).not.toBe(r.runId)
})

it('bounds request storage and excludes failed completion-derived samples', () => {
  let clock = 0
  const d = new diagnostics.LocalDiagnostics(() => clock)
  d.prepare(key.token)
  d.mark(key, 'mtStart')
  clock = 100
  d.mark(key, 'failed')
  d.mark(key, 'complete')
  expect(d.report()!.summary.mtTotalMs).toBeUndefined()
  for (let id = 1; id <= 4100; id++) d.mark({ ...key, id }, 'received')
  expect(d.report()!.requests).toHaveLength(4096)
  expect(d.report()!.truncated).toBe(true)
})

it('saves local reports idempotently without overwriting and propagates filesystem failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shiyi-diagnostics-'))
  try {
    const d = new diagnostics.LocalDiagnostics()
    d.prepare(key.token)
    const report = d.finish(key.token)!
    const path = await diagnostics.saveDiagnostics(report, join(directory, 'reports'))
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(report)
    await writeFile(path, 'preserved')
    expect(await diagnostics.saveDiagnostics(report, join(directory, 'reports'))).toBe(path)
    expect(await readFile(path, 'utf8')).toBe('preserved')
    const file = join(directory, 'file')
    await writeFile(file, 'x')
    await expect(diagnostics.saveDiagnostics(report, file)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('continues measuring short requests after the session has run longer than an hour', () => {
  let clock = 0
  const d = new diagnostics.LocalDiagnostics(() => clock)
  d.prepare(key.token)
  clock = 3600100
  d.mark(key, 'asrStart')
  clock = 3600150
  d.mark(key, 'asrEnd')
  expect(d.report()!.summary.asrMs).toEqual({ n: 1, median: 50, p95: 50 })
})
