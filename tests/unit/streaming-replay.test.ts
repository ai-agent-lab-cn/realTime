import { it, expect } from 'vitest'
// @ts-expect-error independent experiment helper
import {
  decodePcmWav,
  replayPcm,
  energyBounds,
  stablePrefixLatency,
} from '../../scripts/local/streaming-asr/replay.mjs'
import { readFile } from 'node:fs/promises'

it('decodes a fixed PCM16 sample without confusing channels or header bytes', async () => {
  const pcm = decodePcmWav(await readFile('tests/fixtures/local/numbers.wav'))
  expect(pcm).toBeInstanceOf(Float32Array)
  expect(pcm.length).toBe(78763)
  expect([...pcm].every((x) => Math.abs(x) <= 1)).toBe(true)
  expect(() => decodePcmWav(Buffer.from('invalid'))).toThrow()
})
it('paces each sample exactly once and never sends audio before its capture end', async () => {
  let now = 0
  const chunks: any[] = []
  const pcm = Float32Array.from({ length: 3201 }, (_, i) => i / 4000)
  const stats = await replayPcm(pcm, async (event: any) => chunks.push({ ...event, at: now }), {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    leadMs: 100,
    trailMs: 100,
  })
  expect(chunks.map((x) => x.pcm.length)).toEqual([1600, 1600, 1600, 1600, 1])
  expect(chunks.map((x) => x.sequence)).toEqual([0, 1, 2, 3, 4])
  expect(chunks.every((x) => x.at >= x.sampleEndMs)).toBe(true)
  expect(chunks.flatMap((x) => [...x.pcm]).slice(1600, 4801)).toEqual([...pcm])
  expect(stats.inputSamples).toBe(6401)
})
it('stops replay without sending later chunks after cancellation', async () => {
  const controller = new AbortController()
  let count = 0,
    now = 0
  await expect(
    replayPcm(
      new Float32Array(4800),
      async () => {
        count++
        controller.abort()
      },
      {
        signal: controller.signal,
        now: () => now,
        sleep: async (ms: number) => {
          now += ms
        },
        leadMs: 0,
        trailMs: 0,
      },
    ),
  ).rejects.toThrow()
  expect(count).toBe(1)
})
it('finds energy speech boundaries and leaves silence origins absent', () => {
  const samples = new Float32Array(320 * 5)
  samples.fill(0.2, 640, 1280)
  expect(energyBounds(samples)).toEqual({ startMs: 40, endMs: 80 })
  expect(energyBounds(new Float32Array(640))).toEqual({ startMs: null, endMs: null })
})
it('uses a stable three-word prefix rather than a transient earlier hypothesis', () => {
  const events = [
    { accepted: true, fullText: 'We have less', receivedMs: 100 },
    { accepted: true, fullText: 'We have more', receivedMs: 200 },
    { accepted: true, fullText: 'We have more resources', receivedMs: 300 },
  ]
  expect(stablePrefixLatency(events, 'We have more resources', 20)).toBe(180)
  expect(stablePrefixLatency(events, 'We have more resources', null)).toBeNull()
  expect(
    stablePrefixLatency([{ accepted: true, fullText: 'Because', receivedMs: 20 }], 'Because', 0),
  ).toBeNull()
})

it('uses finish time when the last speech segment has no acoustic endpoint', async () => {
  const { terminalBoundaryMs } = await import('../../scripts/local/streaming-asr/replay.mjs')
  expect(
    terminalBoundaryMs([{ type: 'partial', segment: 0, accepted: true, receivedMs: 500 }], 900),
  ).toBe(900)
  expect(
    terminalBoundaryMs(
      [
        { type: 'endpoint', segment: 0, accepted: true, receivedMs: 500 },
        { type: 'partial', segment: 1, accepted: true, receivedMs: 700 },
      ],
      900,
    ),
  ).toBe(900)
  expect(
    terminalBoundaryMs(
      [
        { type: 'partial', segment: 0, accepted: true, receivedMs: 500 },
        { type: 'endpoint', segment: 0, accepted: true, receivedMs: 800 },
      ],
      900,
    ),
  ).toBe(800)
})

it('scores the recognizer terminal text while retaining old display text separately', async () => {
  const { transcriptOutcome } = await import('../../scripts/local/streaming-asr/replay.mjs')
  expect(transcriptOutcome('', 'ONE TWO', [])).toEqual({
    finalText: '',
    displayText: 'ONE TWO',
    terminalStatus: 'empty',
    terminalIssues: [],
  })
  expect(transcriptOutcome('repeated raw text', 'ONE TWO', ['repetition'])).toEqual({
    finalText: 'repeated raw text',
    displayText: 'ONE TWO',
    terminalStatus: 'quality_rejected',
    terminalIssues: ['repetition'],
  })
})
it('does not use an earlier boundary for a later quality-rejected nonempty segment', async () => {
  const { terminalBoundaryMs } = await import('../../scripts/local/streaming-asr/replay.mjs')
  expect(
    terminalBoundaryMs(
      [
        { type: 'endpoint', segment: 0, accepted: true, text: 'Old text', receivedMs: 1000 },
        {
          type: 'partial',
          segment: 1,
          accepted: false,
          text: 'repeated new words',
          receivedMs: 2000,
        },
      ],
      2500,
    ),
  ).toBe(2500)
})
