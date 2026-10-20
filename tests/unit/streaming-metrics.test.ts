import { describe, expect, it } from 'vitest'
// Standalone experiment helpers are plain ESM and do not enter the application build.
// @ts-expect-error plain experiment module has no TypeScript declaration
import { scoreTranscript, summarizeAsr } from '../../scripts/local/streaming-asr/metrics.mjs'

const sample = (id: string, overrides = {}) => ({
  id,
  group: 'course',
  language: 'en',
  reference: 'one two three four',
  referenceStatus: 'human_confirmed',
  ...overrides,
})
const run = (id: string, repeat: number, overrides = {}) => ({
  id,
  arm: 'A',
  repeat,
  events: [],
  finalText: 'one two three four',
  firstRawMs: 10,
  firstAcceptedMs: 20,
  stablePrefixMs: null,
  endpointDelayMs: 30,
  elapsedMs: 40,
  ...overrides,
})

describe('scoreTranscript', () => {
  it('counts hand-checked substitution, deletion and insertion edits', () => {
    expect(scoreTranscript('one two three four five six', 'one too three five six extra')).toEqual({
      substitutions: 1,
      deletions: 1,
      insertions: 1,
      referenceWords: 6,
      errors: 3,
      wer: 0.5,
    })
  })

  it('ignores case and punctuation while keeping spoken numbers distinct from numerals', () => {
    expect(scoreTranscript('Fifteen, not fifty!', '15 not fifty').wer).toBeCloseTo(1 / 3)
    expect(scoreTranscript('R&D: Time-consuming.', 'r d time consuming').wer).toBe(0)
  })

  it('leaves WER undefined for empty references and reports hallucinated words', () => {
    expect(scoreTranscript('', 'hello')).toEqual({
      substitutions: 0,
      deletions: 0,
      insertions: 1,
      referenceWords: 0,
      errors: 1,
      wer: null,
    })
  })
})

describe('summarizeAsr', () => {
  it('scores confirmed human English and known synthetic English separately, excluding mixed and pending', () => {
    const cases = [
      sample('human'),
      sample('synthetic', { referenceStatus: 'synthetic_known_text', group: 'synthetic' }),
      sample('pending', { referenceStatus: 'pending' }),
      sample('mixed', { language: 'mixed' }),
      sample('unclear', { referenceStatus: 'unclear' }),
    ]
    const rows = cases.map(({ id }) => run(id, 1, { finalText: 'one two four' }))
    const result = summarizeAsr(rows, cases, 1)
    expect(result.humanEnglishWER.A).toMatchObject({
      plannedCases: 1,
      scoredCases: 1,
      referenceWords: 4,
      errors: 1,
      wer: 0.25,
    })
    expect(result.syntheticEnglishWER.A).toMatchObject({
      plannedCases: 1,
      scoredCases: 1,
      referenceWords: 4,
      errors: 1,
      wer: 0.25,
    })
    expect(result.humanEnglishWER.A.details.map((d: { id: string }) => d.id)).toEqual(['human'])
  })

  it('reports failed and completely missing planned runs without treating missing latency as zero', () => {
    const result = summarizeAsr(
      [run('seen', 1), run('seen', 2, { error: 'timeout', finalText: '', firstRawMs: null })],
      [sample('seen'), sample('never')],
      3,
    )
    expect(result.coverage).toEqual({
      planned: 12,
      attempted: 2,
      successful: 1,
      failed: 1,
      missing: 10,
    })
    expect(
      result.byCase.find((r: { id: string; arm: string }) => r.id === 'never' && r.arm === 'A'),
    ).toMatchObject({
      coverage: { planned: 3, attempted: 0, successful: 0, failed: 0, missing: 3 },
      metrics: { firstRawMs: null, stablePrefixMs: null },
    })
    expect(result.overall.A.metrics.firstRawMs).toEqual({ n: 1, median: 10, p95: 10 })
    expect(result.overall.B.metrics.firstRawMs).toEqual({ n: 0, median: null, p95: null })
    expect(result.humanEnglishWER.A).toMatchObject({
      plannedCases: 2,
      scoredCases: 1,
      missingCases: 1,
      referenceWords: 4,
    })
  })

  it('takes each case median first then computes group and overall linear-interpolated P95', () => {
    const cases = [sample('x'), sample('y'), sample('z', { group: 'synthetic' })]
    const rows = [
      run('x', 1, { firstRawMs: 1 }),
      run('x', 2, { firstRawMs: 10 }),
      run('x', 3, { firstRawMs: 1000 }),
      run('y', 1, { firstRawMs: 100 }),
      run('z', 1, { firstRawMs: 1000 }),
    ]
    const result = summarizeAsr(rows, cases, 3)
    expect(result.groups.course.A.metrics.firstRawMs).toEqual({ n: 2, median: 55, p95: 95.5 })
    expect(result.overall.A.metrics.firstRawMs).toMatchObject({ n: 3, median: 100 })
    expect(result.overall.A.metrics.firstRawMs.p95).toBeCloseTo(910)
    expect(result.overall.A.metrics.stablePrefixMs).toEqual({ n: 0, median: null, p95: null })
  })

  it('counts one representative median-WER run per audio rather than multiplying reference words by repeats', () => {
    const result = summarizeAsr(
      [
        run('x', 1),
        run('x', 2, { finalText: 'one two three' }),
        run('x', 3, { finalText: 'one two' }),
      ],
      [sample('x')],
      3,
    )
    expect(result.humanEnglishWER.A).toMatchObject({
      scoredCases: 1,
      referenceWords: 4,
      errors: 1,
      wer: 0.25,
    })
    expect(result.humanEnglishWER.A.details[0]).toMatchObject({
      id: 'x',
      repeat: 2,
      availableRepeats: 3,
    })
  })

  it('rejects duplicate or unplanned rows so they cannot silently inflate coverage', () => {
    expect(() => summarizeAsr([run('x', 1), run('x', 1)], [sample('x')], 3)).toThrow(/duplicate/i)
    expect(() => summarizeAsr([run('unknown', 1)], [sample('x')], 3)).toThrow(/unplanned/i)
  })
})
