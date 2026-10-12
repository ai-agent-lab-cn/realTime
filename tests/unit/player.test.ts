import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useInterpreter } from '../../src/stores/interpreter'
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())
it('暂停冻结所有模拟更新，继续从下一段开始', () => {
  const s = useInterpreter()
  s.start()
  vi.advanceTimersByTime(1000)
  expect(s.session.captions.length).toBe(1)
  s.pause()
  const before = JSON.stringify(s.session.captions)
  vi.advanceTimersByTime(10000)
  expect(JSON.stringify(s.session.captions)).toBe(before)
  s.resume()
  vi.advanceTimersByTime(1000)
  expect(s.session.captions.length).toBe(2)
  expect(s.session.captions[0].final).toBe(false)
  s.stop()
})
it('重复点击开始不增加播放速度，结束释放计时器', () => {
  const s = useInterpreter()
  s.start()
  s.start()
  vi.advanceTimersByTime(5000)
  expect(s.session.captions.filter((c) => c.final)).toHaveLength(1)
  s.stop()
  const before = JSON.stringify(s.session)
  vi.advanceTimersByTime(60000)
  expect(JSON.stringify(s.session)).toBe(before)
  expect(vi.getTimerCount()).toBe(0)
})
it('语料播放完毕自动结束且全部字幕确认', () => {
  const s = useInterpreter()
  s.start()
  vi.advanceTimersByTime(180000)
  expect(s.session.status).toBe('Stopped')
  expect(s.session.captions.length).toBeGreaterThan(5)
  expect(s.session.captions.every((c) => c.final)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('重新开始不混入旧字幕，计时从零开始', () => {
  const s = useInterpreter()
  s.start()
  vi.advanceTimersByTime(6000)
  s.stop()
  s.start()
  expect(s.session.captions).toHaveLength(0)
  expect(s.elapsed).toBe(0)
  s.stop()
})
it('本地模式不播放模拟语料，翻译失败只保留未确认原文', () => {
  const s = useInterpreter()
  s.source = 'local'
  s.start()
  vi.advanceTimersByTime(3000)
  expect(s.session.captions).toEqual([])
  const epoch = s.session.epoch
  s.acceptLocal(
    { id: 0, revision: 1, final: true, time: 0 },
    { en: 'Hello', zh: '', error: 'translation failed' },
    epoch,
  )
  expect(s.session.captions[0]).toMatchObject({ en: 'Hello', final: false })
  s.pause()
  s.acceptLocal({ id: 0, revision: 2, final: true, time: 0 }, { en: 'Hello', zh: '你好' }, epoch)
  expect(s.session.captions[0].zh).toBe('')
  s.stop()
})

it('keeps a hard-cut caption unconfirmed and completes its continuation in the same row', () => {
  const s = useInterpreter()
  s.source = 'local'
  s.start()
  const epoch = s.session.epoch
  s.acceptLocal(
    { id: 0, revision: 17, final: true, time: 0 },
    { en: 'A sentence. In pursuit of', zh: '一句话。', pending: true },
    epoch,
  )
  expect(s.session.captions[0].final).toBe(false)
  s.acceptLocal(
    { id: 1, revision: 3, final: true, time: 12 },
    {
      en: 'A sentence. In pursuit of returns.',
      zh: '一句话。追求回报。',
      caption: { id: 0, revision: 9, time: 0 },
    },
    epoch,
  )
  expect(s.session.captions).toHaveLength(1)
  expect(s.session.captions[0]).toMatchObject({
    id: 0,
    time: 0,
    final: true,
    zh: '一句话。追求回报。',
  })
  s.stop()
})
