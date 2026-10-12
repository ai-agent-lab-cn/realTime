import { expect, it, vi } from 'vitest'
import { LocalRuntime } from '../../electron/local-runtime'
const token = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222'
const input = () => ({
  token,
  id: 0,
  revision: 1,
  pcm: new Float32Array(16000).buffer,
  final: true,
  time: 0,
  terms: true,
})
function models() {
  return {
    prepare: vi.fn(async () => {}),
    recognize: vi.fn(async () => 'Hello'),
    translate: vi.fn(async () => '你好'),
    close: vi.fn(),
  }
}
it('filters silence before translation and normalizes terms', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('[BLANK_AUDIO]')
  expect(await r.transcribe(input())).toEqual({ en: '', zh: '' })
  expect(m.translate).not.toHaveBeenCalled()
  m.recognize.mockResolvedValueOnce('rag API')
  expect((await r.transcribe(input())).en).toBe('RAG API')
})
it('cancellation prevents late recognition from starting translation or replacing new session', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let resolve!: (s: string) => void
  m.recognize.mockImplementationOnce(
    () =>
      new Promise<string>((yes) => {
        resolve = yes
      }),
  )
  const job = r.transcribe(input())
  await Promise.resolve()
  r.cancel(token)
  await r.prepare(other)
  resolve('stale')
  await expect(job).rejects.toThrow()
  expect(m.translate).not.toHaveBeenCalled()
  r.cancel(token)
  expect((await r.transcribe({ ...input(), token: other })).zh).toBe('你好')
})
it('retains recognized original if translation fails, and rejects concurrent work', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.translate.mockRejectedValueOnce(new Error('timeout'))
  const result = await r.transcribe(input())
  expect(result.en).toBe('Hello')
  expect(result.zh).toBe('')
  expect(result.error).toBeTruthy()
  let finish!: (s: string) => void
  m.recognize.mockImplementationOnce(
    () =>
      new Promise<string>((yes) => {
        finish = yes
      }),
  )
  const pending = r.transcribe(input())
  await Promise.resolve()
  await expect(r.transcribe(input())).rejects.toThrow()
  finish('hi')
  await pending
})
it('cancel while preparing cannot authorize or resurrect an old token', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let ready!: () => void
  m.prepare.mockImplementationOnce(
    () =>
      new Promise<void>((yes) => {
        ready = yes
      }),
  )
  const start = r.prepare(token)
  r.cancel(token)
  expect(m.close).toHaveBeenCalledOnce()
  ready()
  await expect(start).rejects.toThrow()
  await expect(r.transcribe(input())).rejects.toThrow()
})

it('quarantines runaway ASR rather than translating or confirming it', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  for (const text of [
    'Because firstly ' + 'the percentage of '.repeat(40),
    'We have a lot of resources and '.repeat(6),
  ]) {
    m.recognize.mockResolvedValueOnce(text)
    const result = await r.transcribe({ ...input(), pcm: new Float32Array(160000).buffer })
    expect(result.en).toBe('')
    expect(result.error).toContain('重复')
  }
  expect(m.translate).not.toHaveBeenCalled()
})
it('reuses unchanged partial translation for Final but clears reuse between sessions', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  await r.transcribe({ ...input(), final: false })
  expect(await r.transcribe({ ...input(), revision: 2 })).toMatchObject({ en: 'Hello', zh: '你好' })
  expect(m.translate).toHaveBeenCalledTimes(1)
  r.cancel(token)
  await r.prepare(other)
  await r.transcribe({ ...input(), token: other })
  expect(m.translate).toHaveBeenCalledTimes(2)
})
it('keeps a useful timeout reason instead of a generic translation failure', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.translate.mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'))
  expect((await r.transcribe(input())).error).toContain('超时')
})
it('publishes recognized original before translation completes', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  let done!: (text: string) => void
  m.translate.mockImplementationOnce(() => new Promise((resolve) => (done = resolve)))
  await r.prepare(token)
  const recognized: string[] = []
  const job = r.transcribe(input(), (en) => recognized.push(en))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(recognized).toEqual(['Hello'])
  done('你好')
  expect((await job).zh).toBe('你好')
})
it('cancels only a superseded request and leaves the local session usable', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (value: string) => void
  m.recognize.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const pending = r.transcribe({ ...input(), final: false })
  r.cancelRequest({ token, id: 0, revision: 1 })
  finish('stale')
  await expect(pending).rejects.toThrow()
  expect(r.active).toBe(true)
  expect(await r.transcribe({ ...input(), revision: 2 })).toMatchObject({ zh: '你好' })
})
it('does not cancel another revision or a stale session when preempting', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (value: string) => void
  m.recognize.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const job = r.transcribe(input())
  r.cancelRequest({ token: other, id: 0, revision: 1 })
  r.cancelRequest({ token, id: 0, revision: 2 })
  finish('Hello')
  expect(await job).toMatchObject({ en: 'Hello', zh: '你好' })
})

it('restores clear standalone questions without rewriting embedded questions', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => text)
  await r.prepare(token)
  for (const [en, expected] of [
    [
      'Second, which is the best measure of growth.',
      'Second, which is the best measure of growth?',
    ],
    ['Why are these costs rising.', 'Why are these costs rising?'],
    ['Costs are rising. Why are they rising.', 'Costs are rising. Why are they rising?'],
    ['This explains why these costs are rising.', 'This explains why these costs are rising.'],
    ['What matters is the cost.', 'What matters is the cost.'],
    ['Which is why we need more time.', 'Which is why we need more time.'],
    ['What is needed is more time.', 'What is needed is more time.'],
    ['How is 3.5 calculated.', 'How is 3.5 calculated?'],
    ['Why is this...', 'Why is this...'],
  ]) {
    m.recognize.mockResolvedValueOnce(en)
    expect((await r.transcribe(input())).en).toBe(expected)
  }
})
it('holds an unfinished hard cut, translates its complete prefix and joins only the next window', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => '译：' + text)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Research is costly. Companies invest in pursuit of')
  const held = await r.transcribe({ ...input(), revision: 8, pcm: new Float32Array(192000).buffer })
  expect(held).toMatchObject({ pending: true, zh: '译：Research is costly.' })
  m.recognize.mockResolvedValueOnce('of higher returns.')
  const early = vi.fn()
  const next = await r.transcribe({ ...input(), id: 1, time: 12 }, early)
  expect(next).toMatchObject({
    en: 'Research is costly. Companies invest in pursuit of higher returns.',
    caption: { id: 0, revision: 9, time: 0 },
  })
  expect(next.pending).not.toBe(true)
  expect(early).not.toHaveBeenCalled()
})
it('does not merge complete sentences, a gap, changed terminology or another session', async () => {
  for (const patch of [{ time: 30 }, { terms: false }, { token: other }]) {
    const m = models(),
      r = new LocalRuntime(m)
    await r.prepare(token)
    m.recognize.mockResolvedValueOnce('Companies invest in pursuit of')
    await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
    if (patch.token) {
      r.cancel(token)
      await r.prepare(other)
    }
    m.recognize.mockResolvedValueOnce('A different topic.')
    const result = await r.transcribe({ ...input(), id: 1, time: 12, ...patch })
    expect(result.en).toBe('A different topic.')
    expect(result.caption).toBeUndefined()
  }
})
it('does not hide a pending original when the continuation is silence or fails translation', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Companies invest in pursuit of')
  await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
  m.recognize.mockResolvedValueOnce('[BLANK_AUDIO]')
  const empty = await r.transcribe({ ...input(), id: 1, time: 12, final: false })
  expect(empty).toMatchObject({
    en: 'Companies invest in pursuit of',
    pending: true,
    caption: { id: 0 },
  })
  m.recognize.mockResolvedValueOnce('higher returns.')
  m.translate.mockRejectedValueOnce(new Error('failure'))
  const failure = await r.transcribe({ ...input(), id: 1, time: 12, revision: 2 })
  expect(failure.en).toBe('Companies invest in pursuit of higher returns.')
  expect(failure.error).toBeTruthy()
  expect(failure.caption?.id).toBe(0)
})

it('limits continuation to two windows and keeps a still-incomplete joined result unconfirmed', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('We invest in')
  await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
  m.recognize.mockResolvedValueOnce('new products for')
  const second = await r.transcribe({
    ...input(),
    id: 1,
    time: 12,
    pcm: new Float32Array(192000).buffer,
  })
  expect(second).toMatchObject({
    pending: true,
    en: 'We invest in new products for',
    caption: { id: 0 },
  })
  m.recognize.mockResolvedValueOnce('A new sentence.')
  const third = await r.transcribe({ ...input(), id: 2, time: 24 })
  expect(third.caption).toBeUndefined()
  expect(third.en).toBe('A new sentence.')
})
it('keeps a completed hard-limit question separate from the following sentence', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('What is this made of?')
  expect(
    (await r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })).pending,
  ).toBeUndefined()
  m.recognize.mockResolvedValueOnce('Metal.')
  expect((await r.transcribe({ ...input(), id: 1, time: 12 })).caption).toBeUndefined()
})
it('cannot restore carry state when its translation finishes after cancellation', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  await r.prepare(token)
  let finish!: (value: string) => void
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest in')
  m.translate.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const old = r.transcribe({ ...input(), pcm: new Float32Array(192000).buffer })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  r.cancel(token)
  await r.prepare(other)
  finish('迟到')
  await expect(old).rejects.toThrow()
  m.recognize.mockResolvedValueOnce('Another session.')
  expect(
    (await r.transcribe({ ...input(), id: 1, time: 12, token: other })).caption,
  ).toBeUndefined()
})

it('translates completed sentences while leaving an unfinished trailing clause provisional', async () => {
  const m = models(),
    r = new LocalRuntime(m)
  m.translate.mockImplementation(async (text: string) => '译：' + text)
  await r.prepare(token)
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest heavily')
  expect(await r.transcribe({ ...input(), final: false })).toMatchObject({
    pending: true,
    zh: '译：Costs are high.',
  })
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest heavily. Returns increase')
  expect((await r.transcribe({ ...input(), final: false, revision: 2 })).zh).toBe(
    '译：Costs are high. Companies invest heavily.',
  )
  m.recognize.mockResolvedValueOnce('Costs are high. Companies invest heavily. Returns increase.')
  const final = await r.transcribe({ ...input(), revision: 3 })
  expect(final.zh).toBe('译：Costs are high. Companies invest heavily. Returns increase.')
  expect(final.pending).toBeUndefined()
})
