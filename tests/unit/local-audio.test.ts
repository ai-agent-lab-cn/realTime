import { describe, expect, it } from 'vitest'
import { StreamingResampler } from '../../src/audio/resample'
import { SpeechSegmenter } from '../../src/audio/segmenter'
import { TranscriptQueue } from '../../src/audio/transcriptQueue'
import { workletUrl } from '../../src/audio/microphone'

describe('StreamingResampler', () => {
  it('preserves a continuous 16 kHz timeline across irregular 48 kHz chunks', () => {
    const samples = Float32Array.from({ length: 4800 }, (_, i) => i / 4800)
    const resampler = new StreamingResampler(48000)
    const out = [
      resampler.push(samples.slice(0, 137)),
      resampler.push(samples.slice(137, 1301)),
      resampler.push(samples.slice(1301)),
    ]
    const joined = Float32Array.from(out.flatMap((chunk) => Array.from(chunk)))
    expect(joined.length).toBe(1600)
    expect(joined[1000]).toBeCloseTo(0.625, 5)
  })
})

describe('SpeechSegmenter', () => {
  it('uses preroll and emits cumulative Partial then one Final after a pause', () => {
    const segmenter = new SpeechSegmenter()
    const silence = new Float32Array(320)
    const voice = new Float32Array(320).fill(0.1)
    for (let i = 0; i < 15; i++) expect(segmenter.push(silence)).toEqual([])
    const events = []
    for (let i = 0; i < 90; i++) events.push(...segmenter.push(voice))
    for (let i = 0; i < 41; i++) events.push(...segmenter.push(silence))
    expect(events.map((event) => [event.id, event.revision, event.final])).toEqual([
      [0, 1, false],
      [0, 2, true],
    ])
    expect(events[0].pcm.length).toBeGreaterThan(16000)
    expect(events[1].pcm.length).toBeGreaterThan(events[0].pcm.length)
    expect(events[1].pcm.length).toBeLessThanOrEqual(192000)
  })

  it('discards a short click and caps continuous speech below the native limit', () => {
    const segmenter = new SpeechSegmenter()
    const events = []
    for (let i = 0; i < 10; i++) events.push(...segmenter.push(new Float32Array(320).fill(0.1)))
    for (let i = 0; i < 35; i++) events.push(...segmenter.push(new Float32Array(320)))
    expect(events).toEqual([])
    for (let i = 0; i < 630; i++) events.push(...segmenter.push(new Float32Array(320).fill(0.1)))
    expect(events.some((event) => event.final)).toBe(true)
    expect(events.every((event) => event.pcm.length <= 192000)).toBe(true)
  })
  it('does not repeat finalized samples after a hard twelve second split', () => {
    const segmenter = new SpeechSegmenter()
    const events = []
    for (let i = 0; i < 600; i++) events.push(...segmenter.push(new Float32Array(320).fill(0.1)))
    for (let i = 0; i < 75; i++) events.push(...segmenter.push(new Float32Array(320).fill(0.2)))
    const next = events.find((event) => event.id === 1)
    expect(next?.pcm[0]).toBeCloseTo(0.2, 5)
  })
})

it('resolves the worklet beside the page in both packaged and development builds', () => {
  expect(workletUrl('file:///Applications/Shiyi.app/Contents/Resources/app/dist/index.html')).toBe(
    'file:///Applications/Shiyi.app/Contents/Resources/app/dist/audio-capture-worklet.js',
  )
  expect(workletUrl('http://127.0.0.1:5187/')).toBe(
    'http://127.0.0.1:5187/audio-capture-worklet.js',
  )
})

describe('TranscriptQueue', () => {
  it('coalesces stale partials while preserving a queued Final', async () => {
    let finish!: (value: { en: string; zh: string }) => void
    const submitted: Array<{ id: number; revision: number; final: boolean }> = []
    const queue = new TranscriptQueue(
      async (item) => {
        submitted.push(item)
        if (submitted.length === 1) return await new Promise((resolve) => (finish = resolve))
        return { en: 'done', zh: '完成' }
      },
      () => {},
    )
    const pcm = new Float32Array(100).buffer
    queue.enqueue({ token: 't', id: 1, revision: 1, final: false, pcm, time: 0, terms: true })
    queue.enqueue({ token: 't', id: 1, revision: 2, final: false, pcm, time: 0, terms: true })
    queue.enqueue({ token: 't', id: 1, revision: 3, final: true, pcm, time: 0, terms: true })
    finish({ en: 'partial', zh: '临时' })
    await queue.idle()
    expect(submitted.map((item) => [item.revision, item.final])).toEqual([
      [1, false],
      [3, true],
    ])
  })

  it('rejects overload instead of dropping Finals and ignores cancelled results', async () => {
    let finish!: (value: { en: string; zh: string }) => void
    const received: string[] = []
    const queue = new TranscriptQueue(
      async () => await new Promise((resolve) => (finish = resolve)),
      (result) => received.push(result.en),
      2,
    )
    const item = (id: number) => ({
      token: 't',
      id,
      revision: 1,
      final: true,
      pcm: new ArrayBuffer(0),
      time: 0,
      terms: true,
    })
    queue.enqueue(item(0))
    queue.enqueue(item(1))
    queue.enqueue(item(2))
    expect(() => queue.enqueue(item(3))).toThrow(/积压/)
    queue.cancel()
    finish({ en: 'late', zh: '迟到' })
    await queue.idle()
    expect(received).toEqual([])
  })
})

it('gives queued Finals priority over speculative Partials without overload', async () => {
  let finish!: (r: { en: string; zh: string }) => void
  const ids: number[] = []
  const queue = new TranscriptQueue(
    async (request) => {
      ids.push(request.id)
      if (ids.length === 1)
        await new Promise<{ en: string; zh: string }>((resolve) => (finish = resolve))
      return { en: 'ok', zh: '好' }
    },
    () => {},
    2,
  )
  const item = (id: number, final: boolean) => ({
    token: 't',
    id,
    final,
    revision: 1,
    pcm: new ArrayBuffer(4),
    time: 0,
    terms: true,
  })
  queue.enqueue(item(0, false))
  queue.enqueue(item(1, false))
  queue.enqueue(item(2, true))
  expect(() => queue.enqueue(item(3, false))).not.toThrow()
  queue.enqueue(item(4, true))
  finish({ en: 'ok', zh: '好' })
  await queue.idle()
  expect(ids).toEqual([0, 2, 4])
})
it('ends a long spoken block at a clear pause before the hard limit', () => {
  const segmenter = new SpeechSegmenter()
  const events = segmenter.push(new Float32Array(16000 * 5).fill(0.1))
  events.push(...segmenter.push(new Float32Array(16000 * 0.8)))
  expect(events.filter((e) => e.final)).toHaveLength(1)
  expect(events.at(-1)?.pcm.length).toBeLessThan(16000 * 6)
})
it('keeps a short introductory word with the following sentence across a normal pause', () => {
  const s = new SpeechSegmenter()
  const events = s.push(new Float32Array(8000).fill(0.1))
  events.push(...s.push(new Float32Array(11200)))
  expect(events.filter((e) => e.final)).toHaveLength(0)
  events.push(...s.push(new Float32Array(32000).fill(0.1)))
  events.push(...s.push(new Float32Array(16000)))
  expect(events.filter((e) => e.final)).toHaveLength(1)
})
it('keeps a short internal pause within a longer sentence and finalizes at a clear pause', () => {
  const s = new SpeechSegmenter()
  const events = s.push(new Float32Array(16000 * 7).fill(0.1))
  events.push(...s.push(new Float32Array(6400)))
  expect(events.filter((e) => e.final)).toHaveLength(0)
  events.push(...s.push(new Float32Array(16000 * 3).fill(0.1)))
  events.push(...s.push(new Float32Array(16000)))
  expect(events.filter((e) => e.final)).toHaveLength(1)
  expect(events.at(-1)?.pcm.length).toBeLessThanOrEqual(192000)
})
it('uses a short pause near the upper limit rather than cutting into the next question', () => {
  const s = new SpeechSegmenter()
  const events = s.push(new Float32Array(16000 * 10.2).fill(0.1))
  events.push(...s.push(new Float32Array(16000 * 0.3)))
  expect(events.filter((e) => e.final)).toHaveLength(1)
  expect(events.at(-1)?.pcm.length).toBeLessThan(16000 * 11)
})
it('preempts an active Partial when its Final arrives without failing the session', async () => {
  let reject!: (error: Error) => void
  const received: number[] = [],
    failures: unknown[] = []
  const queue = new TranscriptQueue(
    async (request) => {
      if (!request.final) return new Promise((_yes, no) => (reject = no))
      return { en: 'Final', zh: '完成' }
    },
    (_result, request) => received.push(request.revision),
    3,
    (error) => failures.push(error),
    () => reject(new Error('superseded')),
  )
  const item = {
    token: 't',
    id: 0,
    revision: 1,
    final: false,
    pcm: new ArrayBuffer(4),
    time: 0,
    terms: true,
  }
  queue.enqueue(item)
  queue.enqueue({ ...item, revision: 2, final: true })
  await queue.idle()
  expect(received).toEqual([2])
  expect(failures).toEqual([])
})

it('reports sample-based voice start/end separately from preroll and trailing silence', () => {
  const segmenter = new SpeechSegmenter()
  segmenter.push(new Float32Array(4800))
  const events = segmenter.push(new Float32Array(32000).fill(0.1))
  events.push(...segmenter.push(new Float32Array(16000)))
  const final = events.find((e) => e.final)!
  expect(final.speechStart).toBeCloseTo(0.3)
  expect(final.speechEnd).toBeCloseTo(2.3)
  expect(final.end).toBeCloseTo(2.9)
  expect(final.time).toBe(0)
})
