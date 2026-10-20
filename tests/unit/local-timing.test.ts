import { expect, it } from 'vitest'
import { LocalRenderTimings } from '../../src/audio/localTiming'
const request = { token: '11111111-1111-4111-8111-111111111111', id: 0, revision: 1 }
it('uses sample durations and renderer-local elapsed time without subtracting main clocks', () => {
  let now = 100
  const sent: any[] = [],
    frames: Array<() => void> = []
  const timing = new LocalRenderTimings(
    request.token,
    (e) => sent.push(e),
    () => true,
    () => now,
    (cb) => {
      frames.push(cb)
      return () => {}
    },
  )
  timing.enqueued(request, { speechStart: 0.3, speechEnd: 1.6, audioEnd: 1.8 })
  now = 125
  timing.submitted(request)
  now = 600
  timing.acknowledged(request)
  timing.changed(request, 0, 'en', () => true)
  now = 616
  frames.shift()!()
  expect(sent.find((e) => e.metric === 'audioAccumulationMs').value).toBeCloseTo(1500)
  expect(sent.find((e) => e.metric === 'asrQueueMs').value).toBe(25)
  expect(sent.find((e) => e.metric === 'roundTripMs').value).toBe(475)
  expect(sent.find((e) => e.metric === 'englishRenderMs').value).toBe(16)
  expect(sent.find((e) => e.metric === 'speechToEnglishMs').value).toBeCloseTo(2016)
})
it('discards pending frame timing after release and rejects a stale displayed value', () => {
  let active = true
  const sent: any[] = [],
    frames: Array<() => void> = []
  const timing = new LocalRenderTimings(
    request.token,
    (e) => sent.push(e),
    () => active,
    () => 100,
    (cb) => {
      frames.push(cb)
      return () => {}
    },
  )
  timing.enqueued(request, { speechStart: 0, speechEnd: 1, audioEnd: 1.5 })
  timing.changed(request, 0, 'zh', () => false)
  frames.shift()!()
  expect(sent).toEqual([])
  timing.changed(request, 0, 'en', () => true)
  active = false
  timing.dispose()
  frames.shift()!()
  expect(sent).toEqual([])
})
it('uses the original caption speech origin for a second audio window', () => {
  let now = 0
  const sent: any[] = [],
    frames: Array<() => void> = []
  const timing = new LocalRenderTimings(
    request.token,
    (e) => sent.push(e),
    () => true,
    () => now,
    (cb) => {
      frames.push(cb)
      return () => {}
    },
  )
  timing.enqueued(request, { speechStart: 0, speechEnd: 11.5, audioEnd: 12 })
  timing.changed(request, 0, 'en', () => true)
  frames.shift()!()
  const next = { ...request, id: 1 }
  now = 1000
  timing.enqueued(next, { speechStart: 12, speechEnd: 15, audioEnd: 15.6 })
  now = 1400
  timing.changed(next, 0, 'zh', () => true)
  timing.changed(next, 0, 'final', () => true)
  now = 1420
  frames.splice(0).forEach((f) => f())
  expect(sent.find((e) => e.metric === 'speechToChineseMs').value).toBeCloseTo(16020)
  expect(sent.find((e) => e.metric === 'speechEndToFinalMs').value).toBeCloseTo(1020)
})
